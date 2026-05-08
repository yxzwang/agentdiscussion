const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.AGENTDISCUSSION_STATE_FILE = path.join(
  os.tmpdir(),
  `agentdiscussion-open-state-${process.pid}.json`,
);
process.env.AGENTDISCUSSION_SCHEDULE_FILE = path.join(
  os.tmpdir(),
  `agentdiscussion-schedules-${process.pid}.json`,
);

const {
  buildPrompt,
  createServer,
  getPathCacheFile,
  readPathCache,
  resolveWorkingDirectory,
} = require("../server");

const ROOT = path.resolve(__dirname, "..");

test("health endpoint exposes available agents and timeout", async () => {
  const server = createServer();
  const port = await listen(server);

  try {
    const response = await requestJson(port, "/api/health");

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.agents.codex, "Codex");
    assert.equal(response.body.agents.claudecode, "Claude Code");
    assert.equal(typeof response.body.agentTimeoutMs, "number");
    assert.ok(response.body.agentTimeoutMs > 0);
    assert.equal(response.body.defaultWorkingDir, ROOT);
  } finally {
    await close(server);
  }
});

test("path resolver accepts relative and absolute directories", async () => {
  assert.equal(await resolveWorkingDirectory("."), ROOT);
  assert.equal(await resolveWorkingDirectory(ROOT), ROOT);
});

test("path resolver endpoint rejects missing directories", async () => {
  const server = createServer();
  const port = await listen(server);

  try {
    const response = await requestJson(port, "/api/paths/resolve", {
      method: "POST",
      body: {
        path: path.join(ROOT, "missing-dir-for-test"),
      },
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /Working directory does not exist/);
  } finally {
    await close(server);
  }
});

test("path browser lists parent and child directories", async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agentdiscussion-path-test-"));
  const childDir = path.join(tempDir, "child-a");
  await fsp.mkdir(childDir);
  const server = createServer();
  const port = await listen(server);

  try {
    const response = await requestJson(
      port,
      `/api/paths/browse?path=${encodeURIComponent(tempDir)}`,
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.workingDir, tempDir);
    assert.equal(response.body.parent, path.dirname(tempDir));
    assert.ok(response.body.directories.some((entry) => entry.name === "child-a"));
    assert.ok(response.body.directories.some((entry) => entry.path === childDir));
  } finally {
    await close(server);
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test("reply endpoint starts a background job and persists the final reply", async () => {
  let captured;
  const server = createServer({
    runAgent: async (agentConfig, prompt, options) => {
      captured = { agentConfig, prompt, options };
      return {
        reply: "mocked reply",
        sessionState: { sessionId: "8f253d4f-d1a9-4b8f-85a7-f69e5ae84fd0" },
      };
    },
  });
  const port = await listen(server);

  try {
    const response = await requestJson(port, "/api/agents/claudecode/reply", {
      method: "POST",
      body: {
        agent: {
          id: "agent-1",
          name: "ClaudeCode-1",
          label: "Claude Code 1",
        },
        room: {
          id: "room-1",
          name: "评审讨论",
        },
        workingDir: __dirname,
        sessionState: {
          sessionId: "9bba3f1e-7aed-44ab-8a60-326da0a14112",
        },
        activeRoomId: "room-1",
        typingMessageId: "typing-1",
        roomSnapshot: {
          id: "room-1",
          name: "评审讨论",
          workingDir: __dirname,
          agents: [
            {
              id: "agent-1",
              type: "claudecode",
              name: "ClaudeCode-1",
              label: "Claude Code 1",
              replying: true,
              sessionState: {
                sessionId: "9bba3f1e-7aed-44ab-8a60-326da0a14112",
              },
            },
          ],
          messages: [
            { id: "user-1", sender: "user", author: "你", text: "@ClaudeCode-1 review this" },
            {
              id: "typing-1",
              sender: "agent",
              agentId: "agent-1",
              author: "Claude Code 1",
              text: "正在处理",
              typing: true,
              replyTo: { id: "user-1", author: "你", text: "@ClaudeCode-1 review this" },
            },
          ],
        },
        message: "@ClaudeCode-1 review this",
        cleanMessage: "review this",
        conversation: [{ author: "User", text: "Previous message" }],
      },
    });

    assert.equal(response.statusCode, 202);
    assert.equal(response.body.job.status, "running");
    assert.equal(response.body.room.messages.some((message) => message.typing), true);
    await waitFor(() => captured, 1000);
    assert.equal(captured.agentConfig.label, "Claude Code");
    assert.equal(captured.options.workingDir, __dirname);
    assert.deepEqual(captured.options.sessionState, {
      sessionId: "9bba3f1e-7aed-44ab-8a60-326da0a14112",
    });
    assert.match(captured.prompt, /Claude Code agent/);
    assert.match(captured.prompt, /评审讨论/);
    assert.match(captured.prompt, escapeRegExp(__dirname));
    assert.match(captured.prompt, /review this/);
    assert.match(captured.prompt, /Previous message/);

    const completedState = await waitFor(async () => {
      const state = await requestJson(port, "/api/cache/state");
      const room = state.body.rooms.find((item) => item.id === "room-1");
      const reply = room?.messages.find((message) => message.text === "mocked reply");
      return reply ? { state, room, reply } : null;
    }, 1000);

    assert.equal(completedState.room.messages.some((message) => message.typing), false);
    assert.equal(completedState.reply.id, "typing-1");
    assert.equal(completedState.reply.replyTo.id, "user-1");
    assert.deepEqual(completedState.room.agents[0].sessionState, {
      sessionId: "8f253d4f-d1a9-4b8f-85a7-f69e5ae84fd0",
    });
  } finally {
    await close(server);
  }
});

test("agent timeout restarts without session and keeps the job going", async () => {
  const calls = [];
  const server = createServer({
    runAgent: async (agentConfig, prompt, options) => {
      calls.push({ agentConfig, prompt, options });
      if (calls.length === 1) {
        throw new Error("codex.cmd timed out after 300000ms");
      }
      return {
        reply: "retry reply",
        sessionState: { sessionId: "9e359067-f04a-4465-adcd-060d4e6c275a" },
      };
    },
  });
  const port = await listen(server);

  try {
    const response = await requestJson(port, "/api/agents/codex/reply", {
      method: "POST",
      body: {
        agent: {
          id: "agent-codex-retry",
          type: "codex",
          name: "Codex-1",
          label: "Codex 1",
        },
        room: {
          id: "room-retry",
          name: "Retry room",
        },
        workingDir: ROOT,
        sessionState: {
          sessionId: "684731bb-692a-4419-962d-bcae787e6c47",
        },
        activeRoomId: "room-retry",
        typingMessageId: "typing-retry",
        roomSnapshot: {
          id: "room-retry",
          name: "Retry room",
          workingDir: ROOT,
          agents: [
            {
              id: "agent-codex-retry",
              type: "codex",
              name: "Codex-1",
              label: "Codex 1",
              replying: true,
              sessionState: {
                sessionId: "684731bb-692a-4419-962d-bcae787e6c47",
              },
            },
          ],
          messages: [
            { id: "user-retry", sender: "user", author: "User", text: "@Codex-1 retry" },
            {
              id: "typing-retry",
              sender: "agent",
              agentId: "agent-codex-retry",
              author: "Codex 1",
              text: "Working",
              typing: true,
              replyTo: { id: "user-retry", author: "User", text: "@Codex-1 retry" },
            },
          ],
        },
        message: "@Codex-1 retry",
        cleanMessage: "retry",
        conversation: [{ author: "User", text: "@Codex-1 retry" }],
      },
    });

    assert.equal(response.statusCode, 202);

    const completed = await waitFor(async () => {
      const state = await requestJson(port, "/api/cache/state");
      const room = state.body.rooms.find((item) => item.id === "room-retry");
      return room?.messages.some((message) => message.text === "retry reply") ? room : null;
    }, 1000);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].options.sessionState, {
      sessionId: "684731bb-692a-4419-962d-bcae787e6c47",
    });
    assert.deepEqual(calls[1].options.sessionState, {});
    assert.equal(calls[1].options.restarted, true);
    const reply = completed.messages.find((message) => message.text === "retry reply");
    assert.equal(reply.id, "typing-retry");
    assert.equal(reply.replyTo.id, "user-retry");
    assert.equal(completed.messages.some((message) => /调用失败|timed out/.test(message.text)), false);
  } finally {
    await close(server);
  }
});

test("agent replies can mention another agent and start a delegated job", async () => {
  const calls = [];
  let finishDelegatedAgent;
  const delegatedAgentFinished = new Promise((resolve) => {
    finishDelegatedAgent = resolve;
  });
  const server = createServer({
    runAgent: async (agentConfig, prompt, options) => {
      calls.push({ agentConfig, prompt, options });

      if (calls.length === 1) {
        return {
          reply: "@ClaudeCode-1 please review the implementation",
          sessionState: { sessionId: "7587f74d-a3e0-4d05-bbc0-1233a6a38a34" },
        };
      }

      await delegatedAgentFinished;
      return {
        reply: "delegated review done",
        sessionState: { sessionId: "64f4ad21-e6fa-411a-b13a-f4d6cdb3b128" },
      };
    },
  });
  const port = await listen(server);

  try {
    const response = await requestJson(port, "/api/agents/codex/reply", {
      method: "POST",
      body: {
        agent: {
          id: "agent-codex",
          type: "codex",
          name: "Codex-1",
          label: "Codex 1",
        },
        room: {
          id: "room-delegate",
          name: "Delegate room",
        },
        workingDir: ROOT,
        activeRoomId: "room-delegate",
        typingMessageId: "typing-codex",
        roomSnapshot: {
          id: "room-delegate",
          name: "Delegate room",
          workingDir: ROOT,
          agents: [
            {
              id: "agent-codex",
              type: "codex",
              name: "Codex-1",
              label: "Codex 1",
              replying: true,
            },
            {
              id: "agent-claude",
              type: "claudecode",
              name: "ClaudeCode-1",
              label: "Claude Code 1",
              sessionState: { sessionId: "2f4fd4a6-57ef-47a0-932e-a0b226e2774f" },
            },
          ],
          messages: [
            { id: "user-delegate", sender: "user", author: "User", text: "@Codex-1 plan" },
            {
              id: "typing-codex",
              sender: "agent",
              agentId: "agent-codex",
              author: "Codex 1",
              text: "Working",
              typing: true,
              replyTo: { id: "user-delegate", author: "User", text: "@Codex-1 plan" },
            },
          ],
        },
        message: "@Codex-1 plan",
        cleanMessage: "plan",
        conversation: [{ author: "User", text: "@Codex-1 plan" }],
      },
    });

    assert.equal(response.statusCode, 202);
    await waitFor(() => calls.length >= 2, 1000);
    assert.equal(calls[1].agentConfig.label, "Claude Code");
    assert.deepEqual(calls[1].options.sessionState, {
      sessionId: "2f4fd4a6-57ef-47a0-932e-a0b226e2774f",
    });
    assert.match(calls[1].prompt, /please review the implementation/);

    const runningState = await requestJson(port, "/api/cache/state");
    const runningRoom = runningState.body.rooms.find((room) => room.id === "room-delegate");
    const runningDelegatedMessage = runningRoom.messages.find(
      (message) => message.agentId === "agent-claude" && message.typing,
    );
    assert.ok(runningDelegatedMessage);
    assert.equal(runningDelegatedMessage.replyTo.id, "typing-codex");
    assert.equal(
      runningRoom.messages.find((message) => message.text === "@ClaudeCode-1 please review the implementation").id,
      "typing-codex",
    );

    const jobs = await requestJson(port, "/api/jobs");
    assert.ok(jobs.body.jobs.some((job) => job.agentId === "agent-claude" && job.source === "agent-mention"));

    finishDelegatedAgent();
    const completed = await waitFor(async () => {
      const state = await requestJson(port, "/api/cache/state");
      const room = state.body.rooms.find((item) => item.id === "room-delegate");
      return room?.messages.some((message) => message.text === "delegated review done") ? room : null;
    }, 1000);

    const completedDelegatedMessage = completed.messages.find(
      (message) => message.text === "delegated review done",
    );
    assert.equal(completed.messages.some((message) => message.typing), false);
    assert.equal(completedDelegatedMessage.id, runningDelegatedMessage.id);
    assert.equal(completedDelegatedMessage.replyTo.id, "typing-codex");
    assert.equal(completed.agents.find((agent) => agent.id === "agent-claude").replying, false);
    assert.deepEqual(completed.agents.find((agent) => agent.id === "agent-claude").sessionState, {
      sessionId: "64f4ad21-e6fa-411a-b13a-f4d6cdb3b128",
    });
  } finally {
    finishDelegatedAgent();
    await close(server);
  }
});

test("static root serves the chat page", async () => {
  const server = createServer();
  const port = await listen(server);

  try {
    const response = await requestText(port, "/");

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"], /text\/html/);
    assert.match(response.body, /Agent 群聊/);
    assert.match(response.body, /roomList/);
    assert.match(response.body, /cacheStatus/);
    assert.match(response.body, /cacheDialog/);
    assert.match(response.body, /cacheRoomChoices/);
    assert.match(response.body, /pathDialog/);
    assert.match(response.body, /pathDirectoryList/);
    assert.match(response.body, /selectNewRoomPath/);
    assert.match(response.body, /selectRoomPath/);
    assert.match(response.body, /scheduleList/);
    assert.match(response.body, /scheduleDialog/);
    assert.match(response.body, /scheduleAgent/);
    assert.match(response.body, /schedulePrompt/);
    assert.match(response.body, /createSchedule/);
    assert.match(response.body, /resizeHandle/);
    assert.match(response.body, /roomPathInput/);
    assert.match(response.body, /app\.js/);
  } finally {
    await close(server);
  }
});

test("cache state persists open rooms but path cache only keeps rooms with user messages", async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agentdiscussion-cache-test-"));
  const server = createServer();
  const port = await listen(server);

  try {
    const response = await requestJson(port, "/api/cache/state", {
      method: "POST",
      body: {
        activeRoomId: "room-with-history",
        rooms: [
          {
            id: "room-with-history",
            name: "有历史",
            workingDir: tempDir,
            counters: { codex: 2, claudecode: 1 },
            agents: [
              {
                id: "agent-codex",
                type: "codex",
                name: "Codex-1",
                label: "Codex 1",
                sessionState: { sessionId: "019e0120-a93b-7cd1-ad42-244bbb19a5c7" },
              },
            ],
            messages: [
              { id: "sys-1", sender: "system", text: "created" },
              { id: "user-1", sender: "user", author: "你", text: "@Codex-1 hello" },
            ],
          },
          {
            id: "empty-room",
            name: "空房间",
            workingDir: tempDir,
            agents: [],
            messages: [{ id: "sys-2", sender: "system", text: "created" }],
          },
          {
            id: "second-room-with-history",
            name: "第二个有历史",
            workingDir: tempDir,
            agents: [],
            messages: [{ id: "user-2", sender: "user", author: "你", text: "hello again" }],
          },
        ],
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);

    const openState = await requestJson(port, "/api/cache/state");
    assert.equal(openState.statusCode, 200);
    assert.equal(openState.body.exists, true);
    assert.equal(openState.body.rooms.length, 3);
    assert.equal(openState.body.activeRoomId, "room-with-history");

    const pathCache = await readPathCache(tempDir);
    const cacheFileStat = await fsp.stat(getPathCacheFile(tempDir));
    assert.ok(cacheFileStat.isFile());
    assert.equal(pathCache.rooms.length, 2);
    assert.deepEqual(
      pathCache.rooms.map((room) => room.id).sort(),
      ["room-with-history", "second-room-with-history"],
    );
    const firstRoom = pathCache.rooms.find((room) => room.id === "room-with-history");
    assert.deepEqual(firstRoom.agents[0].sessionState, {
      sessionId: "019e0120-a93b-7cd1-ad42-244bbb19a5c7",
    });

    const legacyCache = JSON.parse(await fsp.readFile(getPathCacheFile(tempDir), "utf8"));
    legacyCache.rooms = legacyCache.rooms.map((room) => {
      if (room.id !== "room-with-history") return room;
      const { workingDir, ...legacyRoom } = room;
      return legacyRoom;
    });
    await fsp.writeFile(
      getPathCacheFile(tempDir),
      `${JSON.stringify(legacyCache, null, 2)}\n`,
      "utf8",
    );
    const legacyPathCache = await readPathCache(tempDir);
    assert.equal(
      legacyPathCache.rooms.find((room) => room.id === "room-with-history").workingDir,
      tempDir,
    );

    const cacheList = await requestJson(
      port,
      `/api/cache/rooms?path=${encodeURIComponent(tempDir)}`,
    );
    assert.equal(cacheList.statusCode, 200);
    assert.equal(cacheList.body.rooms.length, 2);
    assert.equal(
      cacheList.body.rooms.find((room) => room.id === "room-with-history").workingDir,
      tempDir,
    );
  } finally {
    await close(server);
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test("scheduled tasks can trigger prompts and be stopped or deleted", async () => {
  const calls = [];
  const server = createServer({
    runAgent: async (agentConfig, prompt, options) => {
      calls.push({ agentConfig, prompt, options });
      return {
        reply: "scheduled reply",
        sessionState: {},
      };
    },
  });
  const port = await listen(server);

  try {
    const saveState = await requestJson(port, "/api/cache/state", {
      method: "POST",
      body: {
        activeRoomId: "room-schedule",
        rooms: [
          {
            id: "room-schedule",
            name: "Schedule room",
            workingDir: ROOT,
            agents: [
              {
                id: "agent-schedule",
                type: "codex",
                name: "Codex-1",
                label: "Codex 1",
              },
            ],
            messages: [{ id: "sys-schedule", sender: "system", text: "created" }],
          },
        ],
      },
    });
    assert.equal(saveState.statusCode, 200);

    const created = await requestJson(port, "/api/schedules", {
      method: "POST",
      body: {
        roomId: "room-schedule",
        agentId: "agent-schedule",
        intervalMs: 100,
        prompt: "scheduled prompt",
      },
    });

    assert.equal(created.statusCode, 201);
    assert.equal(created.body.schedule.active, true);
    assert.equal(created.body.schedule.intervalMs, 100);
    assert.ok(Math.abs(new Date(created.body.schedule.nextRunAt).getTime() - Date.now()) < 1000);
    const savedScheduleFile = JSON.parse(
      await fsp.readFile(process.env.AGENTDISCUSSION_SCHEDULE_FILE, "utf8"),
    );
    assert.ok(
      savedScheduleFile.schedules.some(
        (schedule) => schedule.id === created.body.schedule.id && schedule.prompt === "scheduled prompt",
      ),
    );

    const completed = await waitFor(async () => {
      const state = await requestJson(port, "/api/cache/state");
      const room = state.body.rooms.find((item) => item.id === "room-schedule");
      return room?.messages.some((message) => message.text === "scheduled reply") ? room : null;
    }, 1500);

    assert.ok(calls.length >= 1);
    assert.equal(calls[0].agentConfig.label, "Codex");
    assert.match(calls[0].prompt, /scheduled prompt/);
    assert.ok(completed.messages.some((message) => message.author === "定时任务"));
    const reply = completed.messages.find((message) => message.text === "scheduled reply");
    assert.equal(reply.replyTo.author, "定时任务");

    const stopped = await requestJson(port, `/api/schedules/${created.body.schedule.id}`, {
      method: "PATCH",
      body: { active: false },
    });
    assert.equal(stopped.statusCode, 200);
    assert.equal(stopped.body.schedule.active, false);
    assert.equal(stopped.body.schedule.nextRunAt, null);

    const deleted = await requestJson(port, `/api/schedules/${created.body.schedule.id}`, {
      method: "DELETE",
    });
    assert.equal(deleted.statusCode, 200);

    const list = await requestJson(port, "/api/schedules");
    assert.equal(
      list.body.schedules.some((schedule) => schedule.id === created.body.schedule.id),
      false,
    );
    const scheduleFileAfterDelete = JSON.parse(
      await fsp.readFile(process.env.AGENTDISCUSSION_SCHEDULE_FILE, "utf8"),
    );
    assert.equal(
      scheduleFileAfterDelete.schedules.some((schedule) => schedule.id === created.body.schedule.id),
      false,
    );
  } finally {
    await close(server);
  }
});

test("submitted agent jobs continue after the submit response is returned", async () => {
  let finishAgent;
  const agentFinished = new Promise((resolve) => {
    finishAgent = resolve;
  });
  const server = createServer({
    runAgent: async () => {
      await agentFinished;
      return {
        reply: "late reply",
        sessionState: {},
      };
    },
  });
  const port = await listen(server);

  try {
    const response = await requestJson(port, "/api/agents/claudecode/reply", {
      method: "POST",
      body: {
        agent: {
          id: "agent-1",
          type: "claudecode",
          name: "ClaudeCode-1",
          label: "Claude Code 1",
        },
        room: {
          id: "room-late",
          name: "后台讨论",
        },
        workingDir: ROOT,
        activeRoomId: "room-late",
        typingMessageId: "typing-late",
        roomSnapshot: {
          id: "room-late",
          name: "后台讨论",
          workingDir: ROOT,
          agents: [
            {
              id: "agent-1",
              type: "claudecode",
              name: "ClaudeCode-1",
              label: "Claude Code 1",
              replying: true,
            },
          ],
          messages: [
            { id: "user-late", sender: "user", author: "你", text: "@ClaudeCode-1 wait" },
            {
              id: "typing-late",
              sender: "agent",
              agentId: "agent-1",
              author: "Claude Code 1",
              text: "正在处理",
              typing: true,
              replyTo: { id: "user-late", author: "你", text: "@ClaudeCode-1 wait" },
            },
          ],
        },
        message: "@ClaudeCode-1 wait",
      },
    });

    assert.equal(response.statusCode, 202);
    const runningState = await requestJson(port, "/api/cache/state");
    const runningRoom = runningState.body.rooms.find((room) => room.id === "room-late");
    assert.equal(runningRoom.messages.some((message) => message.typing), true);

    finishAgent();
    const completed = await waitFor(async () => {
      const state = await requestJson(port, "/api/cache/state");
      const room = state.body.rooms.find((item) => item.id === "room-late");
      return room?.messages.some((message) => message.text === "late reply") ? room : null;
    }, 1000);

    assert.equal(completed.messages.some((message) => message.typing), false);
    const completedReply = completed.messages.find((message) => message.text === "late reply");
    assert.equal(completedReply.id, "typing-late");
    assert.equal(completedReply.replyTo.id, "user-late");
    assert.equal(completed.agents[0].replying, false);
  } finally {
    await close(server);
  }
});

test("buildPrompt preserves room metadata and conversation context", () => {
  const conversation = Array.from({ length: 25 }, (_, index) => ({
    author: `A${index}`,
    text: `message-${index}`,
  }));

  const prompt = buildPrompt({
    type: "codex",
    agent: { label: "Codex 1" },
    room: { name: "实现讨论" },
    workingDir: ROOT,
    message: "@Codex-1 implement",
    cleanMessage: "implement",
    conversation,
  });

  assert.match(prompt, /message-0/);
  assert.match(prompt, /message-6/);
  assert.match(prompt, /message-7/);
  assert.match(prompt, /message-24/);
  assert.match(prompt, /实现讨论/);
  assert.match(prompt, escapeRegExp(ROOT));
});

test("reply endpoint rejects invalid working directories before running agents", async () => {
  let called = false;
  const server = createServer({
    runAgent: async () => {
      called = true;
      return "should not run";
    },
  });
  const port = await listen(server);

  try {
    const response = await requestJson(port, "/api/agents/codex/reply", {
      method: "POST",
      body: {
        message: "@Codex-1 implement",
        workingDir: path.join(ROOT, "missing-dir-for-reply"),
      },
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /Working directory does not exist/);
    assert.equal(called, false);
  } finally {
    await close(server);
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function requestJson(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const bodyText = options.body ? JSON.stringify(options.body) : "";
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: options.method || "GET",
        headers: bodyText
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(bodyText),
            }
          : undefined,
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => {
          raw += chunk.toString();
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode,
            body: raw ? JSON.parse(raw) : null,
          });
        });
      },
    );

    request.on("error", reject);
    request.end(bodyText);
  });
}

function requestText(port, path) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => {
          raw += chunk.toString();
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: raw,
          });
        });
      },
    );

    request.on("error", reject);
    request.end();
  });
}

async function waitFor(callback, timeoutMs) {
  const startedAt = Date.now();
  let lastValue;

  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await callback();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function escapeRegExp(value) {
  return new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}
