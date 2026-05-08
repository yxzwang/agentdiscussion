const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5173);
const MAX_BODY_BYTES = 512 * 1024;
const DEFAULT_AGENT_TIMEOUT_MS = 300000;
const AGENT_TIMEOUT_MS = readPositiveIntegerEnv("AGENT_TIMEOUT_MS", DEFAULT_AGENT_TIMEOUT_MS);
const AGENT_KILL_GRACE_MS = 3000;
const AGENT_RESTART_RETRY_LIMIT = 1;
const APP_DATA_DIR = path.join(ROOT, ".mca");
const OPEN_STATE_FILE = process.env.AGENTDISCUSSION_STATE_FILE || path.join(APP_DATA_DIR, "open-rooms.json");
const SCHEDULE_STATE_FILE =
  process.env.AGENTDISCUSSION_SCHEDULE_FILE || path.join(APP_DATA_DIR, "schedules.json");
const PATH_CACHE_DIR = ".agentdiscussion-cache";
const PATH_CACHE_FILE = "rooms.json";
const BACKGROUND_JOBS = new Map();
const SCHEDULE_TIMERS = new Map();
const MIN_SCHEDULE_INTERVAL_MS = 100;
let SCHEDULES = [];
let schedulesLoaded = false;
let schedulerContext = { runAgent };

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const AGENTS = {
  codex: {
    label: "Codex",
    command: process.env.CODEX_COMMAND || commandName("codex"),
    buildArgs: async ({ workingDir, sessionState }) => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agentdiscussion-codex-"));
      const outputFile = path.join(tempDir, "last-message.txt");
      const sessionId = cleanSessionId(sessionState?.sessionId);
      const startedAt = Date.now();

      if (sessionId) {
        return {
          cleanupDir: tempDir,
          outputFile,
          sessionId,
          startedAt,
          workingDir,
          args: [
            "--ask-for-approval",
            "never",
            "exec",
            "resume",
            "--skip-git-repo-check",
            "--output-last-message",
            outputFile,
            sessionId,
            "-",
          ],
        };
      }

      return {
        cleanupDir: tempDir,
        outputFile,
        startedAt,
        workingDir,
        args: [
          "--ask-for-approval",
          "never",
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--cd",
          workingDir,
          "--color",
          "never",
          "--output-last-message",
          outputFile,
          "-",
        ],
      };
    },
    readResult: async (result) => {
      const sessionId =
        cleanSessionId(result.sessionId) ||
        extractSessionIdFromText(result.stdout) ||
        (await findLatestCodexSessionId(result.workingDir, result.startedAt));
      const sessionState = sessionId ? { sessionId } : {};

      if (result.outputFile && fs.existsSync(result.outputFile)) {
        const fileText = await fsp.readFile(result.outputFile, "utf8");
        if (fileText.trim()) return { reply: fileText.trim(), sessionState };
      }

      return { reply: cleanCliText(result.stdout), sessionState };
    },
  },
  claudecode: {
    label: "Claude Code",
    command: process.env.CLAUDE_COMMAND || commandName("claude"),
    buildArgs: async ({ workingDir, sessionState }) => {
      const sessionId = cleanSessionId(sessionState?.sessionId);
      const args = [
        "--print",
        "--input-format",
        "text",
        "--output-format",
        "json",
        "--permission-mode",
        "bypassPermissions",
        "--add-dir",
        workingDir,
      ];

      if (sessionId) {
        args.push("--resume", sessionId);
      }

      return { args, sessionId, workingDir };
    },
    readResult: async (result) => {
      const parsed = parseJsonObject(result.stdout);
      const reply = cleanCliText(
        parsed?.result || parsed?.content || parsed?.message || parsed?.text || result.stdout,
      );
      const sessionId =
        cleanSessionId(parsed?.session_id) ||
        cleanSessionId(parsed?.sessionId) ||
        cleanSessionId(result.sessionId) ||
        extractSessionIdFromText(result.stdout);
      return {
        reply,
        sessionState: sessionId ? { sessionId } : {},
      };
    },
  },
};

function commandName(base) {
  return process.platform === "win32" ? `${base}.cmd` : base;
}

function createServer(options = {}) {
  const runAgentImpl = options.runAgent || runAgent;
  schedulerContext = { runAgent: runAgentImpl };
  ensureSchedulesLoaded().catch(() => {});

  return http.createServer(async (request, response) => {
    try {
      await routeRequest(request, response, { runAgent: runAgentImpl });
    } catch (error) {
      sendJson(response, error.statusCode || 500, {
        error: error.message || "Internal server error",
      });
    }
  });
}

async function routeRequest(request, response, context) {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url, "http://localhost");

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      agentTimeoutMs: AGENT_TIMEOUT_MS,
      defaultWorkingDir: ROOT,
      agents: Object.fromEntries(
        Object.entries(AGENTS).map(([type, agent]) => [type, agent.label]),
      ),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/cache/state") {
    const state = await readOpenState();
    sendJson(response, 200, state);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/cache/state") {
    await handleSaveState(request, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/cache/rooms") {
    await handleListCachedRooms(url, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/jobs") {
    sendJson(response, 200, { jobs: [...BACKGROUND_JOBS.values()] });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/schedules") {
    await handleListSchedules(response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/schedules") {
    await handleCreateSchedule(request, response);
    return;
  }

  const scheduleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)$/);
  if (scheduleMatch) {
    if (request.method === "PATCH") {
      await handleUpdateSchedule(request, response, scheduleMatch[1]);
      return;
    }

    if (request.method === "DELETE") {
      await handleDeleteSchedule(response, scheduleMatch[1]);
      return;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/paths/browse") {
    await handleBrowsePath(url, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/paths/resolve") {
    await handleResolvePath(request, response);
    return;
  }

  const replyMatch = url.pathname.match(/^\/api\/agents\/([a-z]+)\/reply$/);
  if (request.method === "POST" && replyMatch) {
    await handleAgentReply(request, response, replyMatch[1], context);
    return;
  }

  if (request.method === "GET") {
    await serveStatic(url.pathname, response);
    return;
  }

  sendJson(response, 405, { error: "Method not allowed" });
}

async function handleResolvePath(request, response) {
  const payload = await readJsonBody(request);
  const workingDir = await resolveWorkingDirectory(payload.path);
  sendJson(response, 200, { workingDir });
}

async function handleBrowsePath(url, response) {
  const workingDir = await resolveWorkingDirectory(url.searchParams.get("path"));
  let entries;

  try {
    entries = await fsp.readdir(workingDir, { withFileTypes: true });
  } catch (error) {
    throw new HttpError(400, `Cannot read directory: ${workingDir}`);
  }

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(workingDir, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const parent = path.dirname(workingDir);

  sendJson(response, 200, {
    workingDir,
    parent: parent === workingDir ? null : parent,
    directories,
  });
}

async function handleListSchedules(response) {
  await ensureSchedulesLoaded();
  sendJson(response, 200, { schedules: SCHEDULES });
}

async function handleCreateSchedule(request, response) {
  await ensureSchedulesLoaded();
  const payload = await readJsonBody(request);
  const intervalMs = normalizeScheduleInterval(payload.intervalMs);
  const prompt = String(payload.prompt || "").trim();
  if (!prompt) throw new HttpError(400, "Prompt is required");

  const state = await readOpenState();
  const room = state.rooms.find((item) => item.id === String(payload.roomId || ""));
  if (!room) throw new HttpError(404, "Room not found");
  const agent = room.agents.find((item) => item.id === String(payload.agentId || ""));
  if (!agent) throw new HttpError(404, "Agent not found");

  const now = new Date().toISOString();
  const active = payload.active !== false;
  const schedule = {
    id: createServerId("schedule"),
    roomId: room.id,
    roomName: room.name,
    agentId: agent.id,
    agentName: agent.label || agent.name,
    intervalMs,
    prompt,
    active,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    nextRunAt: active ? now : null,
    lastError: "",
  };

  SCHEDULES.push(schedule);
  await persistSchedules();
  syncScheduleTimer(schedule);
  sendJson(response, 201, { schedule });
}

async function handleUpdateSchedule(request, response, scheduleId) {
  await ensureSchedulesLoaded();
  const payload = await readJsonBody(request);
  const schedule = SCHEDULES.find((item) => item.id === scheduleId);
  if (!schedule) throw new HttpError(404, "Schedule not found");

  if (Object.prototype.hasOwnProperty.call(payload, "active")) {
    schedule.active = Boolean(payload.active);
    schedule.nextRunAt = schedule.active
      ? new Date(Date.now() + schedule.intervalMs).toISOString()
      : null;
    schedule.lastError = "";
  }

  schedule.updatedAt = new Date().toISOString();
  await persistSchedules();
  syncScheduleTimer(schedule);
  sendJson(response, 200, { schedule });
}

async function handleDeleteSchedule(response, scheduleId) {
  await ensureSchedulesLoaded();
  const index = SCHEDULES.findIndex((item) => item.id === scheduleId);
  if (index < 0) throw new HttpError(404, "Schedule not found");

  const [schedule] = SCHEDULES.splice(index, 1);
  clearScheduleTimer(schedule.id);
  await persistSchedules();
  sendJson(response, 200, { ok: true });
}

async function handleSaveState(request, response) {
  const payload = await readJsonBody(request);
  const rooms = Array.isArray(payload.rooms) ? payload.rooms : [];
  const sanitizedRooms = [];

  for (const room of rooms) {
    sanitizedRooms.push(await sanitizeRoomSnapshot(room));
  }

  const result = await writeOpenRoomsState(sanitizedRooms, payload.activeRoomId);
  sendJson(response, 200, { ok: true, ...result });
}

async function handleListCachedRooms(url, response) {
  const workingDir = await resolveWorkingDirectory(url.searchParams.get("path"));
  const cache = await readPathCache(workingDir);
  const rooms = cache.rooms
    .filter(hasUserMessage)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  sendJson(response, 200, { workingDir, rooms });
}

async function handleAgentReply(request, response, type, context) {
  const agentConfig = AGENTS[type];
  if (!agentConfig) {
    sendJson(response, 404, { error: `Unknown agent type: ${type}` });
    return;
  }

  const payload = await readJsonBody(request);
  const message = String(payload.message || "").trim();
  if (!message) {
    sendJson(response, 400, { error: "Message is required" });
    return;
  }

  const workingDir = await resolveWorkingDirectory(payload.workingDir);
  const roomSnapshot = await sanitizeRoomSnapshot(
    payload.roomSnapshot || {
      id: payload.room?.id,
      name: payload.room?.name,
      workingDir,
      agents: [payload.agent || {}],
      messages: Array.isArray(payload.conversation) ? payload.conversation : [],
    },
  );
  roomSnapshot.workingDir = workingDir;

  const agentId = String(payload.agent?.id || "");
  const typingMessageId = String(payload.typingMessageId || "");
  const latestAgent = roomSnapshot.agents.find((agent) => agent.id === agentId);
  if (latestAgent) latestAgent.replying = true;

  const jobId = createServerId("job");
  const typingMessage = roomSnapshot.messages.find((message) => message.id === typingMessageId);
  if (typingMessage) {
    typingMessage.typing = true;
    typingMessage.jobId = jobId;
  }
  const job = {
    id: jobId,
    type,
    status: "running",
    roomId: roomSnapshot.id,
    agentId,
    typingMessageId,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  BACKGROUND_JOBS.set(jobId, job);

  await upsertOpenRoom(roomSnapshot, payload.activeRoomId || roomSnapshot.id, true);

  const prompt = buildPrompt({
    type,
    agent: payload.agent || {},
    room: roomSnapshot,
    workingDir,
    message,
    cleanMessage: String(payload.cleanMessage || ""),
    conversation: Array.isArray(payload.conversation) ? payload.conversation : [],
  });

  runBackgroundAgentJob({
    job,
    agentConfig,
    prompt,
    context,
    workingDir,
    sessionState: payload.sessionState || {},
    roomSnapshot,
  });

  sendJson(response, 202, { job, room: roomSnapshot });
}

async function runBackgroundAgentJob({
  job,
  agentConfig,
  prompt,
  context,
  workingDir,
  sessionState,
  roomSnapshot,
}) {
  try {
    const result = await runAgentWithRestartRetry({
      agentConfig,
      prompt,
      context,
      workingDir,
      sessionState,
    });
    const { reply, sessionState: nextSessionState } = normalizeAgentResult(result);
    job.status = "completed";
    job.updatedAt = new Date().toISOString();
    await finishBackgroundJob({
      job,
      roomSnapshot,
      reply,
      sessionState: nextSessionState,
      context,
    });
  } catch (error) {
    job.status = "failed";
    job.error = error.message || "Agent failed";
    job.updatedAt = new Date().toISOString();
    await finishBackgroundJob({
      job,
      roomSnapshot,
      errorMessage: job.error,
      context,
    });
  }
}

async function runAgentWithRestartRetry({
  agentConfig,
  prompt,
  context,
  workingDir,
  sessionState,
}) {
  let lastError;

  for (let attempt = 0; attempt <= AGENT_RESTART_RETRY_LIMIT; attempt += 1) {
    try {
      const result = await context.runAgent(agentConfig, prompt, {
        workingDir,
        sessionState: attempt === 0 ? sessionState : {},
        restarted: attempt > 0,
        attempt: attempt + 1,
      });
      return result;
    } catch (error) {
      lastError = error;
      if (attempt >= AGENT_RESTART_RETRY_LIMIT || !isRetryableAgentError(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

function isRetryableAgentError(error) {
  const message = String(error?.message || error || "");
  return /timed out after|exited with code|returned an empty response|Failed to start/i.test(message);
}

function buildPrompt({ type, agent, room, workingDir, message, cleanMessage, conversation }) {
  const role =
    type === "codex"
      ? "你是 Codex coding agent，偏重实现方案、代码修改和验证。"
      : "你是 Claude Code agent，偏重协作讨论、风险提醒和方案评审。";

  const transcript = conversation
    .map((item) => {
      const author = item.author || item.sender || "unknown";
      return `${author}: ${item.text || ""}`;
    })
    .join("\n");
  const agentDirectory = Array.isArray(room?.agents)
    ? room.agents.map((item) => `@${item.name}`).join(", ")
    : "";

  return [
    role,
    `当前讨论组是 ${room?.name || "讨论组"}。`,
    `你的群聊昵称是 ${agent.label || agent.name || "Agent"}。`,
    `本次运行目录是 ${workingDir || ROOT}。`,
    agentDirectory ? `当前讨论组可点名的 agent：${agentDirectory}。` : "",
    "你在一个多 agent 群聊里。默认所有 agent 都静默，只有当前消息明确 @ 你时，你才会被后端调用并回复。",
    "如果你需要把后续任务分配给其他 agent，可以在回复中明确 @它的昵称；后端会继续调用被 @ 的 agent。",
    "请只回复这次被 @ 的消息，不要替其他 agent 发言，不要声称自己已经修改文件。",
    "回复要适合直接显示在群聊里，简洁、具体、中文优先。",
    "",
    "最近群聊记录：",
    transcript || "(暂无)",
    "",
    "当前用户消息：",
    message,
    "",
    "去掉 @ 后的用户请求：",
    cleanMessage || message,
  ].filter(Boolean).join("\n");
}

async function runAgent(agentConfig, prompt, options = {}) {
  const workingDir = options.workingDir || ROOT;
  const commandSetup = await agentConfig.buildArgs({
    workingDir,
    sessionState: options.sessionState || {},
  });

  try {
    const result = await runProcess(agentConfig.command, commandSetup.args, prompt, {
      signal: options.signal,
      cwd: workingDir,
    });
    const agentResult = await agentConfig.readResult({ ...result, ...commandSetup });
    const { reply, sessionState } = normalizeAgentResult(agentResult);
    if (!reply.trim()) {
      throw new Error(`${agentConfig.label} returned an empty response`);
    }
    return {
      reply: reply.trim(),
      sessionState,
    };
  } finally {
    if (commandSetup.cleanupDir) {
      await fsp.rm(commandSetup.cleanupDir, { recursive: true, force: true });
    }
  }
}

function runProcess(command, args, stdinText, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(getAbortReason(options.signal));
      return;
    }

    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: process.env,
      shell: process.platform === "win32",
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let processError = null;
    let killTimer = null;

    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };

    const stopProcess = (error) => {
      processError = error;
      killProcessTree(child, false);
      killTimer = setTimeout(() => {
        killProcessTree(child, true);
        settle(reject, processError);
      }, AGENT_KILL_GRACE_MS);
    };

    const onAbort = () => {
      if (settled || processError) return;
      stopProcess(getAbortReason(options.signal));
    };

    const timer = setTimeout(() => {
      if (settled || processError) return;
      stopProcess(new Error(`${command} timed out after ${AGENT_TIMEOUT_MS}ms`));
    }, AGENT_TIMEOUT_MS);

    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      settle(
        reject,
        new Error(
          `Failed to start ${command}. Make sure it is installed and available in PATH. ${error.message}`,
        ),
      );
    });

    child.on("close", (code) => {
      if (processError) {
        settle(reject, processError);
        return;
      }

      if (code !== 0) {
        settle(
          reject,
          new Error(
            `${command} exited with code ${code}. ${tail(stderr || stdout || "No output")}`,
          ),
        );
        return;
      }

      settle(resolve, { stdout, stderr });
    });

    child.stdin.end(stdinText);
  });
}

async function resolveWorkingDirectory(value) {
  const rawPath = String(value || "").trim();
  const candidate = rawPath
    ? path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(ROOT, rawPath))
    : ROOT;

  let stats;
  try {
    stats = await fsp.stat(candidate);
  } catch {
    throw new HttpError(400, `Working directory does not exist: ${candidate}`);
  }

  if (!stats.isDirectory()) {
    throw new HttpError(400, `Working path is not a directory: ${candidate}`);
  }

  return candidate;
}

async function readOpenState() {
  const state = await readJsonFile(OPEN_STATE_FILE, null);
  if (!state || !Array.isArray(state.rooms)) {
    return {
      exists: false,
      version: 1,
      activeRoomId: null,
      rooms: [],
    };
  }

  const rooms = state.rooms.map((room) => normalizeStoredRoom(room)).filter(Boolean);
  return {
    exists: true,
    version: 1,
    savedAt: state.savedAt || null,
    activeRoomId: rooms.some((room) => room.id === state.activeRoomId) ? state.activeRoomId : null,
    rooms,
  };
}

async function readPathCache(workingDir) {
  const cacheFile = getPathCacheFile(workingDir);
  const cache = await readJsonFile(cacheFile, null);
  if (!cache || !Array.isArray(cache.rooms)) {
    return {
      version: 1,
      workingDir,
      rooms: [],
    };
  }

  return {
    version: 1,
    workingDir,
    savedAt: cache.savedAt || null,
    rooms: cache.rooms.map((room) => normalizeStoredRoom(room, workingDir)).filter(Boolean),
  };
}

async function writeOpenRoomsState(rooms, activeRoomId) {
  const savedAt = new Date().toISOString();
  const cleanRooms = rooms.map((room) => normalizeStoredRoom(room)).filter(Boolean);
  const state = {
    version: 1,
    savedAt,
    activeRoomId: cleanRooms.some((room) => room.id === activeRoomId) ? activeRoomId : null,
    rooms: cleanRooms,
  };

  await writeJsonFile(OPEN_STATE_FILE, state);
  const cacheResults = await writePathCaches(cleanRooms, savedAt);
  return { savedAt, cacheResults };
}

async function upsertOpenRoom(room, activeRoomId, addIfMissing) {
  const state = await readOpenState();
  const rooms = state.rooms;
  const index = rooms.findIndex((item) => item.id === room.id);

  if (index >= 0) {
    rooms[index] = normalizeStoredRoom(room);
  } else if (addIfMissing) {
    rooms.push(normalizeStoredRoom(room));
  }

  await writeOpenRoomsState(rooms, activeRoomId || state.activeRoomId || room.id);
}

async function finishBackgroundJob({ job, roomSnapshot, reply, sessionState, errorMessage, context }) {
  const state = await readOpenState();
  const roomIndex = state.rooms.findIndex((room) => room.id === job.roomId);
  const openRoom = roomIndex >= 0 ? state.rooms[roomIndex] : null;
  const room = openRoom || normalizeStoredRoom(roomSnapshot);
  const now = new Date().toISOString();

  const agent = room.agents.find((item) => item.id === job.agentId);
  if (agent) {
    agent.replying = false;
    if (sessionState && Object.keys(sessionState).length > 0) {
      agent.sessionState = sessionState;
    }
  }

  const typingIndex = room.messages.findIndex((message) => message.id === job.typingMessageId);
  const existingTyping = typingIndex >= 0 ? room.messages[typingIndex] : null;
  const replyMessage = {
    id: existingTyping?.id || createServerId(errorMessage ? "reply-error" : "reply"),
    sender: "agent",
    agentId: job.agentId,
    author: agent?.label || "Agent",
    text: errorMessage ? `真实 agent 调用失败：${errorMessage}` : reply,
    typing: false,
    jobId: job.id,
    replyTo: existingTyping?.replyTo,
    createdAt: now,
  };

  if (typingIndex >= 0) {
    room.messages[typingIndex] = {
      ...existingTyping,
      ...replyMessage,
    };
  } else {
    room.messages.push(replyMessage);
  }
  room.updatedAt = now;

  if (roomIndex >= 0) {
    state.rooms[roomIndex] = room;
    await writeOpenRoomsState(state.rooms, state.activeRoomId || room.id);
  }

  await writePathCaches([room], now);

  if (!errorMessage && context) {
    await queueMentionedAgentJobs({
      room,
      sourceMessage: replyMessage,
      sourceAgentId: job.agentId,
      activeRoomId: state.activeRoomId || room.id,
      context,
      keepOpen: roomIndex >= 0,
    });
  }
}

async function queueMentionedAgentJobs({
  room,
  sourceMessage,
  sourceAgentId,
  activeRoomId,
  context,
  keepOpen,
}) {
  const targets = getMentionedAgents(sourceMessage.text, room)
    .filter((agent) => agent.id !== sourceAgentId)
    .filter((agent) => !agent.replying);

  for (const target of targets) {
    await startMentionedAgentJob({
      room,
      sourceMessage,
      target,
      activeRoomId,
      context,
      keepOpen,
    });
  }
}

async function startMentionedAgentJob({ room, sourceMessage, target, activeRoomId, context, keepOpen }) {
  const agentConfig = AGENTS[target.type];
  if (!agentConfig) return null;

  const now = new Date().toISOString();
  const jobId = createServerId("job");
  const typingMessage = {
    id: createServerId("typing"),
    sender: "agent",
    agentId: target.id,
    author: target.label,
    text: "正在处理",
    typing: true,
    jobId,
    replyTo: createReplyReference(sourceMessage),
    createdAt: now,
  };

  target.replying = true;
  room.messages.push(typingMessage);
  room.updatedAt = now;

  const job = {
    id: jobId,
    type: target.type,
    status: "running",
    roomId: room.id,
    agentId: target.id,
    typingMessageId: typingMessage.id,
    startedAt: now,
    updatedAt: now,
    source: "agent-mention",
    sourceMessageId: sourceMessage.id,
  };
  BACKGROUND_JOBS.set(jobId, job);

  if (keepOpen) {
    await upsertOpenRoom(room, activeRoomId || room.id, true);
  }
  await writePathCaches([room], now);

  const prompt = buildPrompt({
    type: target.type,
    agent: target,
    room,
    workingDir: room.workingDir,
    message: sourceMessage.text,
    cleanMessage: stripMentions(sourceMessage.text, room),
    conversation: buildConversationSnapshot(room),
  });

  runBackgroundAgentJob({
    job,
    agentConfig,
    prompt,
    context,
    workingDir: room.workingDir,
    sessionState: target.sessionState || {},
    roomSnapshot: normalizeStoredRoom(room),
  });

  return job;
}

function getMentionedAgents(text, room) {
  const matches = new Set();

  room.agents.forEach((agent) => {
    const pattern = new RegExp(
      `(^|\\s)@${escapeRegExp(agent.name)}(?=$|\\s|[,.!?，。！？:：；;])`,
      "i",
    );

    if (pattern.test(text)) {
      matches.add(agent.id);
    }
  });

  return room.agents.filter((agent) => matches.has(agent.id));
}

function stripMentions(text, room) {
  return room.agents
    .reduce((value, agent) => {
      const pattern = new RegExp(`@${escapeRegExp(agent.name)}`, "gi");
      return value.replace(pattern, "");
    }, text)
    .trim();
}

function createReplyReference(message) {
  return sanitizeReplyReference({
    id: message?.id,
    author: message?.author || "Agent",
    text: message?.text || "",
  });
}

function buildConversationSnapshot(room) {
  return room.messages
    .filter((message) => !message.typing)
    .map((message) => ({
      sender: message.sender,
      author: message.author || (message.sender === "user" ? "你" : "系统"),
      text: message.text,
    }));
}

async function ensureSchedulesLoaded() {
  if (schedulesLoaded) return;
  const state = await readJsonFile(SCHEDULE_STATE_FILE, null);
  SCHEDULES = Array.isArray(state?.schedules)
    ? state.schedules.map(normalizeSchedule).filter(Boolean)
    : [];
  schedulesLoaded = true;
  SCHEDULES.forEach(syncScheduleTimer);
}

async function persistSchedules() {
  await writeJsonFile(SCHEDULE_STATE_FILE, {
    version: 1,
    savedAt: new Date().toISOString(),
    schedules: SCHEDULES,
  });
}

function normalizeSchedule(schedule) {
  if (!schedule || typeof schedule !== "object") return null;
  const prompt = String(schedule.prompt || "").trim();
  if (!prompt) return null;

  return {
    id: String(schedule.id || createServerId("schedule")),
    roomId: String(schedule.roomId || ""),
    roomName: String(schedule.roomName || "讨论组"),
    agentId: String(schedule.agentId || ""),
    agentName: String(schedule.agentName || "Agent"),
    intervalMs: normalizeScheduleInterval(schedule.intervalMs),
    prompt,
    active: Boolean(schedule.active),
    createdAt: normalizeDateString(schedule.createdAt) || new Date().toISOString(),
    updatedAt: normalizeDateString(schedule.updatedAt) || new Date().toISOString(),
    lastRunAt: normalizeDateString(schedule.lastRunAt) || null,
    nextRunAt: normalizeDateString(schedule.nextRunAt) || null,
    lastError: String(schedule.lastError || ""),
  };
}

function normalizeScheduleInterval(intervalMs) {
  const number = Number(intervalMs);
  if (!Number.isFinite(number) || number < MIN_SCHEDULE_INTERVAL_MS) {
    return MIN_SCHEDULE_INTERVAL_MS;
  }
  return Math.floor(number);
}

function syncScheduleTimer(schedule) {
  clearScheduleTimer(schedule.id);
  if (!schedule.active) return;

  const nextRunTime = new Date(schedule.nextRunAt || 0).getTime();
  const delay = Math.max(0, nextRunTime - Date.now());
  const timer = setTimeout(() => {
    runScheduledTask(schedule.id).catch(() => {});
  }, delay);
  if (typeof timer.unref === "function") timer.unref();
  SCHEDULE_TIMERS.set(schedule.id, timer);
}

function clearScheduleTimer(scheduleId) {
  const timer = SCHEDULE_TIMERS.get(scheduleId);
  if (timer) clearTimeout(timer);
  SCHEDULE_TIMERS.delete(scheduleId);
}

async function runScheduledTask(scheduleId) {
  await ensureSchedulesLoaded();
  const schedule = SCHEDULES.find((item) => item.id === scheduleId);
  if (!schedule || !schedule.active) return;

  const now = new Date().toISOString();
  schedule.lastRunAt = now;
  schedule.nextRunAt = new Date(Date.now() + schedule.intervalMs).toISOString();

  try {
    await dispatchScheduledPrompt(schedule);
    schedule.lastError = "";
  } catch (error) {
    schedule.lastError = error.message || "Schedule run failed";
  }

  schedule.updatedAt = new Date().toISOString();
  await persistSchedules();
  syncScheduleTimer(schedule);
}

async function dispatchScheduledPrompt(schedule) {
  const state = await readOpenState();
  const room = state.rooms.find((item) => item.id === schedule.roomId);
  if (!room) throw new Error("定时任务对应的讨论组未打开");
  const agent = room.agents.find((item) => item.id === schedule.agentId);
  if (!agent) throw new Error("定时任务对应的 agent 不存在");
  if (!AGENTS[agent.type]) throw new Error("定时任务对应的 agent 类型不可用");
  if (agent.replying) throw new Error(`${agent.label || agent.name} 正在处理，跳过本次触发`);

  const now = new Date().toISOString();
  const sourceMessage = {
    id: createServerId("scheduled"),
    sender: "user",
    author: "定时任务",
    text: `@${agent.name} ${schedule.prompt}`.trim(),
    createdAt: now,
  };
  const jobId = createServerId("job");
  const typingMessage = {
    id: createServerId("typing"),
    sender: "agent",
    agentId: agent.id,
    author: agent.label,
    text: "正在处理",
    typing: true,
    jobId,
    replyTo: createReplyReference(sourceMessage),
    createdAt: now,
  };

  agent.replying = true;
  room.messages.push(sourceMessage, typingMessage);
  room.updatedAt = now;
  await upsertOpenRoom(room, state.activeRoomId || room.id, true);

  const job = {
    id: jobId,
    type: agent.type,
    status: "running",
    roomId: room.id,
    agentId: agent.id,
    typingMessageId: typingMessage.id,
    startedAt: now,
    updatedAt: now,
    source: "schedule",
    scheduleId: schedule.id,
  };
  BACKGROUND_JOBS.set(jobId, job);

  runBackgroundAgentJob({
    job,
    agentConfig: AGENTS[agent.type],
    prompt: buildPrompt({
      type: agent.type,
      agent,
      room,
      workingDir: room.workingDir,
      message: sourceMessage.text,
      cleanMessage: schedule.prompt,
      conversation: buildConversationSnapshot(room),
    }),
    context: schedulerContext,
    workingDir: room.workingDir,
    sessionState: agent.sessionState || {},
    roomSnapshot: normalizeStoredRoom(room),
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function writePathCaches(rooms, savedAt) {
  const groups = new Map();

  for (const room of rooms) {
    if (!hasUserMessage(room)) continue;

    const roomGroup = groups.get(room.workingDir) || [];
    roomGroup.push({
      ...room,
      updatedAt: savedAt,
    });
    groups.set(room.workingDir, roomGroup);
  }

  const results = [];
  for (const [workingDir, roomsForPath] of groups) {
    try {
      const cache = await readPathCache(workingDir);
      const roomMap = new Map(cache.rooms.map((room) => [room.id, room]));
      roomsForPath.forEach((room) => {
        roomMap.set(room.id, room);
      });

      await writeJsonFile(getPathCacheFile(workingDir), {
        version: 1,
        workingDir,
        savedAt,
        rooms: [...roomMap.values()],
      });
      results.push({ workingDir, saved: roomsForPath.length });
    } catch (error) {
      results.push({
        workingDir,
        saved: 0,
        error: error.message || "Failed to write path cache",
      });
    }
  }

  return results;
}

async function sanitizeRoomSnapshot(room) {
  const workingDir = await resolveWorkingDirectory(room?.workingDir);
  const now = new Date().toISOString();
  const messages = Array.isArray(room?.messages)
    ? room.messages
        .map((message) => ({
          id: String(message.id || createServerId("message")),
          sender: String(message.sender || "system"),
          author: String(message.author || ""),
          agentId: message.agentId ? String(message.agentId) : undefined,
          text: String(message.text || ""),
          typing: Boolean(message.typing),
          jobId: message.jobId ? String(message.jobId) : undefined,
          replyTo: sanitizeReplyReference(message.replyTo),
          createdAt: normalizeDateString(message.createdAt) || now,
        }))
    : [];

  return {
    id: String(room?.id || createServerId("room")),
    name: String(room?.name || "讨论组"),
    workingDir,
    agents: sanitizeAgents(room?.agents),
    messages,
    counters: sanitizeCounters(room?.counters),
    createdAt: normalizeDateString(room?.createdAt) || now,
    updatedAt: now,
  };
}

function normalizeStoredRoom(room, fallbackWorkingDir = ROOT) {
  if (!room || typeof room !== "object") return null;
  return {
    id: String(room.id || createServerId("room")),
    name: String(room.name || "讨论组"),
    workingDir: String(room.workingDir || fallbackWorkingDir || ROOT),
    agents: sanitizeAgents(room.agents),
    messages: Array.isArray(room.messages)
      ? room.messages
          .map((message) => ({
            id: String(message.id || createServerId("message")),
            sender: String(message.sender || "system"),
            author: String(message.author || ""),
            agentId: message.agentId ? String(message.agentId) : undefined,
            text: String(message.text || ""),
            typing: Boolean(message.typing),
            jobId: message.jobId ? String(message.jobId) : undefined,
            replyTo: sanitizeReplyReference(message.replyTo),
            createdAt: normalizeDateString(message.createdAt) || new Date().toISOString(),
          }))
      : [],
    counters: sanitizeCounters(room.counters),
    createdAt: normalizeDateString(room.createdAt) || new Date().toISOString(),
    updatedAt: normalizeDateString(room.updatedAt) || null,
  };
}

function sanitizeAgents(agents) {
  return Array.isArray(agents)
    ? agents.map((agent) => ({
        id: String(agent.id || createServerId("agent")),
        type: AGENTS[agent.type] ? agent.type : "codex",
        name: String(agent.name || agent.label || "Agent"),
        label: String(agent.label || agent.name || "Agent"),
        initials: String(agent.initials || (agent.type === "claudecode" ? "CC" : "CX")),
        muted: agent.muted !== false,
        replying: Boolean(agent.replying),
        sessionState: sanitizeSessionState(agent.sessionState),
      }))
    : [];
}

function sanitizeReplyReference(replyTo) {
  if (!replyTo || typeof replyTo !== "object") return undefined;
  const id = String(replyTo.id || "");
  const text = String(replyTo.text || "");
  if (!id && !text) return undefined;
  return {
    id,
    author: String(replyTo.author || "消息"),
    text,
  };
}

function sanitizeSessionState(sessionState) {
  if (!sessionState || typeof sessionState !== "object") return {};
  const sessionId = cleanSessionId(sessionState.sessionId);
  return sessionId ? { sessionId } : {};
}

function sanitizeCounters(counters) {
  return {
    codex: readPositiveCounter(counters?.codex),
    claudecode: readPositiveCounter(counters?.claudecode),
  };
}

function hasUserMessage(room) {
  return Array.isArray(room?.messages) && room.messages.some((message) => message.sender === "user");
}

function normalizeAgentResult(result) {
  if (typeof result === "string") {
    return { reply: result, sessionState: {} };
  }

  return {
    reply: String(result?.reply || ""),
    sessionState: sanitizeSessionState(result?.sessionState),
  };
}

function getPathCacheFile(workingDir) {
  return path.join(workingDir, PATH_CACHE_DIR, PATH_CACHE_FILE);
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonFile(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function parseJsonObject(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).reverse();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") return parsed;
      } catch {
        // Try the next line.
      }
    }
  }

  return null;
}

function cleanSessionId(value) {
  const text = String(value || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)
    ? text
    : "";
}

function extractSessionIdFromText(value) {
  const match = String(value || "").match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  return cleanSessionId(match?.[0]);
}

async function findLatestCodexSessionId(workingDir, startedAt) {
  const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
  const files = await listFilesRecursive(sessionsDir).catch(() => []);
  const normalizedWorkingDir = normalizePathForCompare(workingDir);
  const earliestMtime = Number(startedAt || 0) - 5000;

  const candidates = files
    .filter((file) => file.endsWith(".jsonl"))
    .sort((a, b) => {
      const aStat = fs.statSync(a);
      const bStat = fs.statSync(b);
      return bStat.mtimeMs - aStat.mtimeMs;
    });

  for (const file of candidates) {
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat || stat.mtimeMs < earliestMtime) continue;

    const firstLine = await readFirstLine(file);
    const parsed = parseJsonObject(firstLine);
    const payload = parsed?.payload || {};
    if (normalizePathForCompare(payload.cwd) === normalizedWorkingDir) {
      return cleanSessionId(payload.id);
    }
  }

  return "";
}

async function listFilesRecursive(rootDir) {
  const result = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      if (entry.isFile()) result.push(fullPath);
    }
  }

  return result;
}

async function readFirstLine(filePath) {
  const fileText = await fsp.readFile(filePath, "utf8");
  return fileText.split(/\r?\n/, 1)[0] || "";
}

function normalizePathForCompare(value) {
  if (!value) return "";
  return path.resolve(String(value)).toLowerCase();
}

function normalizeDateString(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
}

function readPositiveCounter(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 1;
}

function createServerId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function killProcessTree(child, force) {
  if (!child.pid) return;

  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The process may already be gone.
  }

  if (process.platform !== "win32") return;

  const args = ["/pid", String(child.pid), "/t"];
  if (force) args.push("/f");

  try {
    const killer = spawn("taskkill", args, {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => {});
  } catch {
    // Best-effort cleanup; the original child.kill call above may still work.
  }
}

function getAbortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error("Agent request was cancelled");
}

async function serveStatic(urlPath, response) {
  const requestedPath = urlPath === "/" ? "/index.html" : decodeURIComponent(urlPath);
  const filePath = path.normalize(path.join(ROOT, requestedPath));
  const relativePath = path.relative(ROOT, filePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const file = await fsp.readFile(filePath);
    const contentType = CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream";
    response.writeHead(200, { "Content-Type": contentType });
    response.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendText(response, 404, "Not found");
      return;
    }
    throw error;
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk.toString();
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large"));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    request.on("error", reject);
  });
}

function sendJson(response, statusCode, data) {
  if (!canSend(response)) return;
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function sendText(response, statusCode, text) {
  if (!canSend(response)) return;
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}

function canSend(response) {
  return !response.destroyed && !response.writableEnded;
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function cleanCliText(value) {
  return String(value || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim();
}

function tail(value, maxLength = 1200) {
  const text = cleanCliText(value);
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

function readPositiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

if (require.main === module) {
  createServer().listen(PORT, () => {
    console.log(`Agent discussion server running at http://localhost:${PORT}`);
  });
}

module.exports = {
  AGENTS,
  buildPrompt,
  createServer,
  getPathCacheFile,
  hasUserMessage,
  readOpenState,
  readPathCache,
  resolveWorkingDirectory,
  runAgent,
  runProcess,
  sanitizeRoomSnapshot,
};
