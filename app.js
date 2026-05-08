const agentTypes = {
  codex: {
    label: "Codex",
    initials: "CX",
  },
  claudecode: {
    label: "Claude Code",
    initials: "CC",
  },
};

const API_BASE = window.location.protocol === "file:" ? "http://localhost:5173" : getAppBasePath();
const FALLBACK_AGENT_TIMEOUT_MS = 300000;
const CLIENT_TIMEOUT_PADDING_MS = 5000;
const MIN_CLIENT_TIMEOUT_MS = 10000;
const SAVE_DEBOUNCE_MS = 350;
const SHELL_SIZE_KEY = "agentdiscussion.shellSize";
const STATE_POLL_MS = 1800;
const AUTO_SCROLL_THRESHOLD_PX = 48;
const SCHEDULE_REFRESH_MS = 5000;
const SCHEDULE_DRAFT_KEY = "agentdiscussion.scheduleDraft";
const PATH_DIALOG_DRAFT_KEY = "agentdiscussion.pathDialogDraft";

function getAppBasePath() {
  const scriptSrc = document.currentScript?.src || "";
  if (scriptSrc) {
    try {
      const scriptBase = new URL(".", scriptSrc);
      const scriptPath = scriptBase.pathname.replace(/\/$/, "");
      return scriptPath === "/" ? "" : scriptPath;
    } catch {
      // Fall back to the page path below.
    }
  }

  const pathname = window.location.pathname || "/";
  if (pathname === "/") return "";

  const basePath = pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname.replace(/\/[^/]*$/, "");
  return basePath === "/" ? "" : basePath;
}

const state = {
  rooms: [],
  schedules: [],
  activeRoomId: null,
  defaultWorkingDir: "",
  agentTimeoutMs: FALLBACK_AGENT_TIMEOUT_MS,
  saveTimer: null,
  pollTimer: null,
  scheduleDialog: {
    mode: "create",
    scheduleId: null,
  },
  cacheDialog: {
    sourceRoomId: null,
    rooms: [],
  },
  pathDialog: {
    target: null,
    draftKey: "",
    currentPath: "",
    parentPath: null,
    directories: [],
    history: [],
    historyIndex: -1,
    tree: createEmptyPathTree(),
  },
};

const elements = {
  agentCount: document.querySelector("#agentCount"),
  agentList: document.querySelector("#agentList"),
  addAgent: document.querySelector("#addAgent"),
  cacheStatus: document.querySelector("#cacheStatus"),
  clock: document.querySelector("#clock"),
  createRoom: document.querySelector("#createRoom"),
  createSchedule: document.querySelector("#createSchedule"),
  scheduleList: document.querySelector("#scheduleList"),
  scheduleDialog: document.querySelector("#scheduleDialog"),
  scheduleDialogTitle: document.querySelector("#scheduleDialogTitle"),
  scheduleAgent: document.querySelector("#scheduleAgent"),
  scheduleInterval: document.querySelector("#scheduleInterval"),
  scheduleIntervalUnit: document.querySelector("#scheduleIntervalUnit"),
  scheduleFirstRunMode: document.querySelector("#scheduleFirstRunMode"),
  scheduleFirstRunDelay: document.querySelector("#scheduleFirstRunDelay"),
  scheduleFirstRunUnit: document.querySelector("#scheduleFirstRunUnit"),
  schedulePrompt: document.querySelector("#schedulePrompt"),
  scheduleStatus: document.querySelector("#scheduleStatus"),
  saveSchedule: document.querySelector("#saveSchedule"),
  closeScheduleDialog: document.querySelector("#closeScheduleDialog"),
  cacheDialog: document.querySelector("#cacheDialog"),
  cacheDialogTitle: document.querySelector("#cacheDialogTitle"),
  cacheRoomChoices: document.querySelector("#cacheRoomChoices"),
  closeCacheDialog: document.querySelector("#closeCacheDialog"),
  pathDialog: document.querySelector("#pathDialog"),
  pathDialogTitle: document.querySelector("#pathDialogTitle"),
  pathDialogInput: document.querySelector("#pathDialogInput"),
  pathDialogCurrent: document.querySelector("#pathDialogCurrent"),
  pathHistoryList: document.querySelector("#pathHistoryList"),
  pathDirectoryList: document.querySelector("#pathDirectoryList"),
  pathDialogStatus: document.querySelector("#pathDialogStatus"),
  pathBack: document.querySelector("#pathBack"),
  pathForward: document.querySelector("#pathForward"),
  pathParent: document.querySelector("#pathParent"),
  openPathInput: document.querySelector("#openPathInput"),
  chooseCurrentPath: document.querySelector("#chooseCurrentPath"),
  closePathDialog: document.querySelector("#closePathDialog"),
  mentionStrip: document.querySelector("#mentionStrip"),
  messageInput: document.querySelector("#messageInput"),
  messageList: document.querySelector("#messageList"),
  mutedStatus: document.querySelector("#mutedStatus"),
  newRoomName: document.querySelector("#newRoomName"),
  newRoomPath: document.querySelector("#newRoomPath"),
  selectNewRoomPath: document.querySelector("#selectNewRoomPath"),
  pathStatus: document.querySelector("#pathStatus"),
  replyHint: document.querySelector("#replyHint"),
  roomList: document.querySelector("#roomList"),
  roomNameInput: document.querySelector("#roomNameInput"),
  roomPathInput: document.querySelector("#roomPathInput"),
  selectRoomPath: document.querySelector("#selectRoomPath"),
  roomTitle: document.querySelector("#roomTitle"),
  roomPathLabel: document.querySelector("#roomPathLabel"),
  saveRoomSettings: document.querySelector("#saveRoomSettings"),
  sendMessage: document.querySelector("#sendMessage"),
  shell: document.querySelector(".shell"),
  resizeHandle: document.querySelector("#resizeHandle"),
};

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function readStorageJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorageJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Draft persistence is best-effort; the dialog should keep working without it.
  }
}

function getActiveRoom() {
  return state.rooms.find((room) => room.id === state.activeRoomId) || null;
}

function getSelectedAgentType() {
  return document.querySelector("input[name='agentType']:checked").value;
}

function getSelectedAgentContextMode() {
  return document.querySelector("input[name='agentContextMode']:checked")?.value === "direct"
    ? "direct"
    : "group";
}

function isDirectContextAgent(agent) {
  return agent?.contextMode === "direct";
}

function createRoom({ name, workingDir }) {
  const now = new Date();
  return {
    id: createId("room"),
    name: name.trim() || `讨论组 ${state.rooms.length + 1}`,
    workingDir: String(workingDir || "").trim(),
    agents: [],
    messages: [],
    counters: {
      codex: 1,
      claudecode: 1,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function activateRoom(roomId) {
  if (!state.rooms.some((room) => room.id === roomId)) return;
  state.activeRoomId = roomId;
  render();
  persistOpenStateDebounced();
}

function closeRoom(roomId) {
  const roomIndex = state.rooms.findIndex((room) => room.id === roomId);
  if (roomIndex < 0) return;

  state.rooms.splice(roomIndex, 1);
  if (state.activeRoomId === roomId) {
    state.activeRoomId = state.rooms[roomIndex]?.id || state.rooms[roomIndex - 1]?.id || null;
  }

  setCacheStatus("已关闭");
  render();
  persistOpenStateDebounced();
  syncPollingWithPendingState();
}

async function resumeRoom(roomId) {
  const room = state.rooms.find((item) => item.id === roomId);
  if (!room) return;

  try {
    setCacheStatus("读取中");
    const cachedRooms = await listCachedRooms(room.workingDir);
    if (cachedRooms.length === 0) {
      setCacheStatus("没有可恢复历史");
      return;
    }

    state.cacheDialog = {
      sourceRoomId: room.id,
      rooms: cachedRooms.map(reviveRoom),
    };
    renderCacheDialog(room);
    elements.cacheDialog.hidden = false;
    setCacheStatus(`${cachedRooms.length} 个缓存`);
  } catch (error) {
    setCacheStatus(error.message, true);
  }
}

function restoreCachedRoom(cachedRoomId) {
  const cached = state.cacheDialog.rooms.find((room) => room.id === cachedRoomId);
  if (!cached) return;

  const revived = reviveRoom(cached);
  const existingIndex = state.rooms.findIndex((item) => item.id === revived.id);
  const sourceIndex = state.rooms.findIndex((item) => item.id === state.cacheDialog.sourceRoomId);

  if (existingIndex >= 0) {
    state.rooms[existingIndex] = revived;
    if (sourceIndex >= 0 && sourceIndex !== existingIndex) {
      state.rooms.splice(sourceIndex, 1);
    }
  } else if (sourceIndex >= 0) {
    state.rooms[sourceIndex] = revived;
  } else {
    state.rooms.push(revived);
  }

  state.activeRoomId = revived.id;
  revived.messages.push({
    id: createId("system"),
    sender: "system",
    text: "已从缓存恢复讨论组",
    createdAt: new Date(),
  });
  closeCacheDialog();
  setCacheStatus("已恢复");
  render();
  persistOpenStateDebounced();
  syncPollingWithPendingState();
}

function closeCacheDialog() {
  elements.cacheDialog.hidden = true;
  state.cacheDialog = {
    sourceRoomId: null,
    rooms: [],
  };
}

function getPathDialogDraftKey(target, room) {
  return target === "room-settings" ? `${target}:${room?.id || "none"}` : target;
}

function getPathDialogDraft(draftKey) {
  const drafts = readStorageJson(PATH_DIALOG_DRAFT_KEY, {});
  const draft = drafts && typeof drafts === "object" ? drafts[draftKey] : null;
  return draft && typeof draft === "object" ? draft : {};
}

function persistPathDialogDraft() {
  if (!state.pathDialog.target || !state.pathDialog.draftKey) return;
  const drafts = readStorageJson(PATH_DIALOG_DRAFT_KEY, {});
  drafts[state.pathDialog.draftKey] = {
    currentPath: state.pathDialog.currentPath,
    history: state.pathDialog.history,
    historyIndex: state.pathDialog.historyIndex,
  };
  writeStorageJson(PATH_DIALOG_DRAFT_KEY, drafts);
}

async function openPathDialog(target) {
  const room = getActiveRoom();
  const draftKey = getPathDialogDraftKey(target, room);
  const draft = getPathDialogDraft(draftKey);
  const typedPath =
    target === "new-room"
      ? elements.newRoomPath.value.trim()
      : elements.roomPathInput.value.trim();
  const roomPath = room?.workingDir || state.defaultWorkingDir;
  const seedPath =
    target === "new-room"
      ? typedPath || draft.currentPath || state.defaultWorkingDir
      : (typedPath && typedPath !== roomPath ? typedPath : "") ||
        draft.currentPath ||
        roomPath ||
        state.defaultWorkingDir;

  state.pathDialog = {
    target,
    draftKey,
    currentPath: "",
    parentPath: null,
    directories: [],
    history: Array.isArray(draft.history) ? draft.history : [],
    historyIndex: Number.isInteger(draft.historyIndex) ? draft.historyIndex : -1,
    tree: createEmptyPathTree(),
  };
  elements.pathDialogTitle.textContent = target === "new-room" ? "选择新讨论组路径" : "选择讨论组路径";
  elements.pathDialog.hidden = false;
  await loadPathDialog(seedPath, {
    pushHistory: true,
    fallbackPath: state.defaultWorkingDir || "",
  });
}

function closePathDialog() {
  elements.pathDialog.hidden = true;
  state.pathDialog = {
    target: null,
    draftKey: "",
    currentPath: "",
    parentPath: null,
    directories: [],
    history: [],
    historyIndex: -1,
    tree: createEmptyPathTree(),
  };
  setPathDialogStatus("");
}

function getScheduleDraftKey(mode = state.scheduleDialog.mode, scheduleId = state.scheduleDialog.scheduleId) {
  return mode === "edit" && scheduleId ? `edit:${scheduleId}` : "create";
}

function getScheduleDraft(key = getScheduleDraftKey()) {
  if (state.scheduleDialog.mode === "copy") return {};
  const drafts = readStorageJson(SCHEDULE_DRAFT_KEY, {});
  if (!drafts || typeof drafts !== "object") return {};
  if (drafts[key] && typeof drafts[key] === "object") return drafts[key];
  return key === "create" ? drafts : {};
}

function persistScheduleDraft() {
  const drafts = readStorageJson(SCHEDULE_DRAFT_KEY, {});
  const key = getScheduleDraftKey();
  drafts[key] = {
    agentValue: elements.scheduleAgent.value,
    interval: elements.scheduleInterval.value,
    intervalUnit: elements.scheduleIntervalUnit.value,
    firstRunMode: elements.scheduleFirstRunMode.value,
    firstRunDelay: elements.scheduleFirstRunDelay.value,
    firstRunUnit: elements.scheduleFirstRunUnit.value,
    prompt: elements.schedulePrompt.value,
  };
  writeStorageJson(SCHEDULE_DRAFT_KEY, drafts);
}

function clearScheduleDraft(key = getScheduleDraftKey()) {
  const drafts = readStorageJson(SCHEDULE_DRAFT_KEY, {});
  if (!drafts || typeof drafts !== "object") return;
  delete drafts[key];
  writeStorageJson(SCHEDULE_DRAFT_KEY, drafts);
}

function restoreScheduleDraft(options, fallback = {}) {
  const draft = getScheduleDraft();
  const optionValues = new Set(options.map((option) => option.value));
  const interval = Number(draft.interval ?? fallback.interval ?? 5);
  const intervalUnit = String(draft.intervalUnit || fallback.intervalUnit || "60000");
  const agentValue = draft.agentValue || fallback.agentValue || "";
  const firstRunMode = draft.firstRunMode || fallback.firstRunMode || "immediate";
  const firstRunDelay = Number(draft.firstRunDelay ?? fallback.firstRunDelay ?? 5);
  const firstRunUnit = String(draft.firstRunUnit || fallback.firstRunUnit || "60000");

  if (agentValue && optionValues.has(agentValue)) {
    elements.scheduleAgent.value = agentValue;
  } else if (options[0]) {
    elements.scheduleAgent.value = options[0].value;
  }

  elements.scheduleInterval.value = Number.isFinite(interval) && interval > 0
    ? String(draft.interval ?? fallback.interval ?? 5)
    : "5";
  elements.scheduleIntervalUnit.value = [...elements.scheduleIntervalUnit.options].some(
    (option) => option.value === intervalUnit,
  )
    ? intervalUnit
    : "60000";
  elements.scheduleFirstRunMode.value = firstRunMode === "delay" ? "delay" : "immediate";
  elements.scheduleFirstRunDelay.value = Number.isFinite(firstRunDelay) && firstRunDelay > 0
    ? String(draft.firstRunDelay ?? fallback.firstRunDelay ?? 5)
    : "5";
  elements.scheduleFirstRunUnit.value = [...elements.scheduleFirstRunUnit.options].some(
    (option) => option.value === firstRunUnit,
  )
    ? firstRunUnit
    : "60000";
  elements.schedulePrompt.value = String(draft.prompt ?? fallback.prompt ?? "");
  syncScheduleFirstRunControls();
}

function splitDurationForForm(ms) {
  const value = Math.max(1, Math.round(Number(ms) || 1));
  if (value % 3600000 === 0) return { value: value / 3600000, unit: "3600000" };
  if (value % 60000 === 0) return { value: value / 60000, unit: "60000" };
  if (value % 1000 === 0) return { value: value / 1000, unit: "1000" };
  return { value: Math.ceil(value / 1000), unit: "1000" };
}

function syncScheduleFirstRunControls() {
  const customDelay = elements.scheduleFirstRunMode.value === "delay";
  elements.scheduleFirstRunDelay.disabled = !customDelay;
  elements.scheduleFirstRunUnit.disabled = !customDelay;
}

function getFirstRunDelayMs() {
  if (elements.scheduleFirstRunMode.value !== "delay") return 0;
  const value = Number(elements.scheduleFirstRunDelay.value);
  const unit = Number(elements.scheduleFirstRunUnit.value);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("首次运行时间必须大于 0");
  }
  return Math.round(value * unit);
}

function openScheduleDialog(scheduleId = null, mode = "create") {
  const sourceSchedule = scheduleId
    ? state.schedules.find((schedule) => schedule.id === scheduleId)
    : null;
  const editingSchedule = mode === "edit" ? sourceSchedule : null;
  const copyingSchedule = mode === "copy" ? sourceSchedule : null;
  const options = getScheduleAgentOptions();
  state.scheduleDialog = {
    mode: editingSchedule ? "edit" : copyingSchedule ? "copy" : "create",
    scheduleId: editingSchedule?.id || null,
  };
  elements.scheduleAgent.innerHTML = options
    .map(
      (option) =>
        `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`,
    )
    .join("");
  elements.scheduleDialogTitle.textContent = editingSchedule
    ? "编辑定时任务"
    : copyingSchedule
      ? "复制定时任务"
      : "新建定时任务";
  elements.saveSchedule.textContent = editingSchedule ? "保存修改" : "确认创建";
  elements.scheduleAgent.disabled = Boolean(editingSchedule);

  if (editingSchedule || copyingSchedule) {
    const source = editingSchedule || copyingSchedule;
    const interval = splitDurationForForm(source.intervalMs);
    const nextDelayMs = source.active && source.nextRunAt
      ? Math.max(0, source.nextRunAt.getTime() - Date.now())
      : 0;
    const firstRun = nextDelayMs > 0 ? splitDurationForForm(nextDelayMs) : null;
    restoreScheduleDraft(options, {
      agentValue: `${source.roomId}::${source.agentId}`,
      interval: interval.value,
      intervalUnit: interval.unit,
      firstRunMode: firstRun ? "delay" : "immediate",
      firstRunDelay: firstRun?.value || 5,
      firstRunUnit: firstRun?.unit || "60000",
      prompt: source.prompt,
    });
  } else {
    restoreScheduleDraft(options);
  }

  setScheduleStatus(options.length === 0 ? "先创建讨论组和 agent" : "");
  elements.saveSchedule.disabled = options.length === 0;
  elements.scheduleDialog.hidden = false;
  persistScheduleDraft();
}

function closeScheduleDialog() {
  elements.scheduleDialog.hidden = true;
  setScheduleStatus("");
}

function getScheduleAgentOptions() {
  return state.rooms.flatMap((room) =>
    room.agents.map((agent) => ({
      value: `${room.id}::${agent.id}`,
      label: `${room.name} / ${agent.label || agent.name}`,
    })),
  );
}

async function saveSchedule() {
  const [roomId, agentId] = String(elements.scheduleAgent.value || "").split("::");
  const intervalValue = Number(elements.scheduleInterval.value);
  const unit = Number(elements.scheduleIntervalUnit.value);
  const prompt = elements.schedulePrompt.value.trim();
  let firstRunDelayMs;
  persistScheduleDraft();

  if (!roomId || !agentId) {
    setScheduleStatus("请选择 agent", true);
    return;
  }
  if (!Number.isFinite(intervalValue) || intervalValue <= 0) {
    setScheduleStatus("时间间隔必须大于 0", true);
    return;
  }
  if (!prompt) {
    setScheduleStatus("请输入 prompt", true);
    return;
  }
  try {
    firstRunDelayMs = getFirstRunDelayMs();
  } catch (error) {
    setScheduleStatus(error.message, true);
    return;
  }

  try {
    const intervalMs = Math.round(intervalValue * unit);
    const isEdit = state.scheduleDialog.mode === "edit" && state.scheduleDialog.scheduleId;
    setScheduleStatus(isEdit ? "保存中" : "创建中");

    if (isEdit) {
      await updateSchedule(state.scheduleDialog.scheduleId, {
        intervalMs,
        prompt,
        firstRunDelayMs,
        active: true,
      });
      clearScheduleDraft();
    } else {
      await createSchedule({
        roomId,
        agentId,
        intervalMs,
        prompt,
        firstRunDelayMs,
        active: true,
      });
    }

    await loadSchedules();
    closeScheduleDialog();
  } catch (error) {
    setScheduleStatus(error.message || "保存失败", true);
  }
}

async function loadPathDialog(pathText, options = {}) {
  const requestedPath = normalizePathText(pathText || state.defaultWorkingDir);
  if (requestedPath) elements.pathDialogInput.value = requestedPath;

  try {
    setPathDialogStatus("读取中");
    const payload = await browsePath(requestedPath);
    state.pathDialog.currentPath = payload.workingDir;
    state.pathDialog.parentPath = payload.parent || null;
    state.pathDialog.directories = Array.isArray(payload.directories) ? payload.directories : [];
    await syncPathTree(payload.workingDir, state.pathDialog.directories);

    if (Number.isInteger(options.historyIndex)) {
      state.pathDialog.historyIndex = options.historyIndex;
    } else if (options.pushHistory) {
      const history = state.pathDialog.history.slice(0, state.pathDialog.historyIndex + 1);
      if (history[history.length - 1] !== payload.workingDir) {
        history.push(payload.workingDir);
      }
      state.pathDialog.history = history;
      state.pathDialog.historyIndex = history.length - 1;
    }

    renderPathDialog();
    persistPathDialogDraft();
    setPathDialogStatus("");
  } catch (error) {
    const hasFallbackPath = Object.prototype.hasOwnProperty.call(options, "fallbackPath");
    const fallbackPath = String(options.fallbackPath || "");
    if (hasFallbackPath && fallbackPath !== requestedPath) {
      try {
        const nextOptions = { ...options };
        delete nextOptions.fallbackPath;
        await loadPathDialog(fallbackPath, nextOptions);
        setPathDialogStatus("原路径不可用，已打开默认路径", true);
        return;
      } catch {
        // Show the original path error below; it is more useful to the user.
      }
    }
    setPathDialogStatus(error.message || "读取路径失败", true);
  }
}

async function openTypedPath() {
  const pathText = normalizePathText(elements.pathDialogInput.value);
  if (!pathText) {
    setPathDialogStatus("请输入路径", true);
    return;
  }

  await loadPathDialog(pathText, { pushHistory: true });
}

async function openPathParent() {
  if (!state.pathDialog.parentPath) return;
  await loadPathDialog(state.pathDialog.parentPath, { pushHistory: true });
}

async function movePathHistory(delta) {
  const nextIndex = state.pathDialog.historyIndex + delta;
  if (nextIndex < 0 || nextIndex >= state.pathDialog.history.length) return;
  await loadPathDialog(state.pathDialog.history[nextIndex], { historyIndex: nextIndex });
}

async function openPathHistoryItem(indexText) {
  const index = Number(indexText);
  if (!Number.isInteger(index) || index < 0 || index >= state.pathDialog.history.length) return;
  await loadPathDialog(state.pathDialog.history[index], { historyIndex: index });
}

async function togglePathTreeNode(pathText) {
  const node = getPathTreeNode(pathText);
  if (!node) return;

  if (node.expanded) {
    node.expanded = false;
    renderPathDialog();
    persistPathDialogDraft();
    return;
  }

  node.expanded = true;
  if (!node.loaded) {
    try {
      const payload = await browsePath(node.path);
      setPathTreeNodeDirectories(payload.workingDir, payload.directories);
    } catch (error) {
      node.error = error.message || "路径不可读";
    }
  }

  renderPathDialog();
  persistPathDialogDraft();
}

async function syncPathTree(currentPath, directories) {
  const currentTreePath = normalizeTreePath(currentPath);
  const ancestors = getPathAncestors(currentTreePath);
  if (ancestors.length === 0) return;

  const rootPath = ancestors[0];
  if (!state.pathDialog.tree.roots.includes(rootPath)) {
    state.pathDialog.tree.roots = [rootPath];
  }

  for (const ancestor of ancestors) {
    const node = getOrCreatePathTreeNode(ancestor);
    node.expanded = true;

    if (normalizeTreePath(ancestor) === currentTreePath) {
      setPathTreeNodeDirectories(currentTreePath, directories);
    } else if (!node.loaded) {
      try {
        const payload = await browsePath(ancestor);
        setPathTreeNodeDirectories(payload.workingDir, payload.directories);
      } catch (error) {
        node.error = error.message || "路径不可读";
      }
    }
  }
}

function createEmptyPathTree() {
  return {
    roots: [],
    nodes: {},
  };
}

function getPathTreeNode(pathText) {
  const treePath = normalizeTreePath(pathText);
  return state.pathDialog.tree.nodes[treePath] || null;
}

function getOrCreatePathTreeNode(pathText, fallbackName = "") {
  const treePath = normalizeTreePath(pathText);
  if (!state.pathDialog.tree.nodes[treePath]) {
    state.pathDialog.tree.nodes[treePath] = {
      path: treePath,
      name: fallbackName || getPathBaseName(treePath),
      directories: [],
      loaded: false,
      expanded: false,
      error: "",
    };
  } else if (fallbackName) {
    state.pathDialog.tree.nodes[treePath].name = fallbackName;
  }

  return state.pathDialog.tree.nodes[treePath];
}

function setPathTreeNodeDirectories(pathText, directories) {
  const node = getOrCreatePathTreeNode(pathText);
  node.directories = Array.isArray(directories)
    ? directories.map((directory) => ({
        name: String(directory.name || getPathBaseName(directory.path)),
        path: normalizeTreePath(directory.path),
      }))
    : [];
  node.loaded = true;
  node.error = "";

  node.directories.forEach((directory) => {
    getOrCreatePathTreeNode(directory.path, directory.name);
  });
}

function getPathAncestors(pathText) {
  const treePath = normalizeTreePath(pathText);
  if (!treePath) return [];

  const driveMatch = treePath.match(/^[a-zA-Z]:\\/);
  if (driveMatch) {
    const root = driveMatch[0];
    const parts = treePath.slice(root.length).split(/[\\/]+/).filter(Boolean);
    const ancestors = [root];
    let current = root;
    parts.forEach((part) => {
      current = current.endsWith("\\") ? `${current}${part}` : `${current}\\${part}`;
      ancestors.push(current);
    });
    return ancestors;
  }

  if (treePath.startsWith("\\\\")) {
    const parts = treePath.split("\\").filter(Boolean);
    if (parts.length < 2) return [treePath];
    const root = `\\\\${parts[0]}\\${parts[1]}`;
    const ancestors = [root];
    let current = root;
    parts.slice(2).forEach((part) => {
      current = `${current}\\${part}`;
      ancestors.push(current);
    });
    return ancestors;
  }

  if (treePath.startsWith("/")) {
    const parts = treePath.split("/").filter(Boolean);
    const ancestors = ["/"];
    let current = "/";
    parts.forEach((part) => {
      current = current === "/" ? `/${part}` : `${current}/${part}`;
      ancestors.push(current);
    });
    return ancestors;
  }

  const parts = treePath.split(/[\\/]+/).filter(Boolean);
  const ancestors = [];
  let current = "";
  parts.forEach((part) => {
    current = current ? `${current}/${part}` : part;
    ancestors.push(current);
  });
  return ancestors;
}

function normalizeTreePath(value) {
  let text = normalizePathText(value);
  if (!text) return "";

  const driveMatch = text.match(/^([a-zA-Z]:)[\\/]*$/);
  if (driveMatch) return `${driveMatch[1].toUpperCase()}\\`;
  if (/^[a-zA-Z]:[\\/]/.test(text)) {
    text = text.replace(/\//g, "\\").replace(/\\+$/g, "");
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  if (text.startsWith("\\\\")) return text.replace(/\\+$/g, "");
  if (text === "/") return "/";
  return text.replace(/\/+$/g, "");
}

function getPathBaseName(pathText) {
  const treePath = normalizeTreePath(pathText);
  if (treePath === "/") return "/";
  if (/^[a-zA-Z]:\\$/.test(treePath)) return treePath;
  if (treePath.startsWith("\\\\")) {
    const parts = treePath.split("\\").filter(Boolean);
    return parts[parts.length - 1] || treePath;
  }
  const parts = treePath.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || treePath;
}

function chooseCurrentPath() {
  const selectedPath = state.pathDialog.currentPath;
  if (!selectedPath) return;

  if (state.pathDialog.target === "new-room") {
    elements.newRoomPath.value = selectedPath;
  } else {
    elements.roomPathInput.value = selectedPath;
    setPathStatus("已选择路径");
  }

  closePathDialog();
}

async function createRoomFromForm() {
  const name = elements.newRoomName.value.trim() || `讨论组 ${state.rooms.length + 1}`;
  const pathText = elements.newRoomPath.value.trim() || state.defaultWorkingDir;

  try {
    const workingDir = await resolveWorkingDir(pathText);
    const room = createRoom({ name, workingDir });
    state.rooms.push(room);
    addAgentToRoom(room, "codex", true);
    addAgentToRoom(room, "claudecode", true);
    room.messages.push({
      id: createId("system"),
      sender: "system",
      text: `${room.name} 已创建，运行路径：${formatPath(room.workingDir)}`,
      createdAt: new Date(),
    });
    state.activeRoomId = room.id;
    elements.newRoomName.value = "";
    elements.newRoomPath.value = "";
    setPathStatus("");
    render();
    persistOpenStateDebounced();
  } catch (error) {
    setPathStatus(error.message, true);
  }
}

async function saveActiveRoomSettings() {
  const room = getActiveRoom();
  if (!room) return;

  const nextName = elements.roomNameInput.value.trim() || room.name;
  const requestedPath = elements.roomPathInput.value.trim() || state.defaultWorkingDir || room.workingDir;

  try {
    const nextWorkingDir = await resolveWorkingDir(requestedPath);
    const renamed = nextName !== room.name;
    const pathChanged = nextWorkingDir !== room.workingDir;

    room.name = nextName;
    room.workingDir = nextWorkingDir;

    if (renamed || pathChanged) {
      const parts = [];
      if (renamed) parts.push(`讨论组已重命名为 ${room.name}`);
      if (pathChanged) parts.push(`运行路径已切换为 ${formatPath(room.workingDir)}，已有上下文保留`);
      room.messages.push({
        id: createId("system"),
        sender: "system",
        text: parts.join("；"),
        createdAt: new Date(),
      });
    }

    setPathStatus("已保存");
    render();
    persistOpenStateDebounced();
  } catch (error) {
    setPathStatus(error.message, true);
  }
}

function createAgent(type, room, contextMode = "group") {
  const config = agentTypes[type];
  const number = room.counters[type]++;
  const handleBase = type === "claudecode" ? "ClaudeCode" : config.label;
  const handle = `${handleBase}-${number}`;

  return {
    id: createId(type),
    type,
    name: handle,
    label: `${config.label} ${number}`,
    initials: config.initials,
    muted: true,
    replying: false,
    contextMode: contextMode === "direct" ? "direct" : "group",
    sessionState: {},
  };
}

function addAgent(type = getSelectedAgentType()) {
  const room = getActiveRoom();
  if (!room) return;

  const agent = addAgentToRoom(room, type, false, getSelectedAgentContextMode());
  room.messages.push({
    id: createId("system"),
    sender: "system",
    text: `${agent.label} 已进入讨论组${isDirectContextAgent(agent) ? "（独立上下文）" : ""}`,
    createdAt: new Date(),
  });
  render();
  persistOpenStateDebounced();
}

function addAgentToRoom(room, type, quiet, contextMode = "group") {
  const agent = createAgent(type, room, contextMode);
  room.agents.push(agent);
  if (!quiet) render();
  return agent;
}

function removeAgent(agentId) {
  const room = getActiveRoom();
  if (!room) return;

  const agent = room.agents.find((item) => item.id === agentId);
  room.agents = room.agents.filter((item) => item.id !== agentId);

  if (agent) {
    room.messages.push({
      id: createId("system"),
      sender: "system",
      text: `${agent.label} 已离开讨论组`,
      createdAt: new Date(),
    });
  }

  render();
  persistOpenStateDebounced();
}

function renameAgent(agentId, rawName) {
  const room = getActiveRoom();
  if (!room) return;

  const agent = room.agents.find((item) => item.id === agentId);
  if (!agent) return;

  const nextName = makeUniqueAgentName(room, rawName.trim() || agent.label, agent.id);
  if (nextName === agent.label && nextName === agent.name) {
    renderAgents();
    return;
  }

  const previousLabel = agent.label;
  agent.label = nextName;
  agent.name = nextName;
  room.messages.push({
    id: createId("system"),
    sender: "system",
    text: `${previousLabel} 已重命名为 ${agent.label}`,
    createdAt: new Date(),
  });
  render();
  persistOpenStateDebounced();
}

function makeUniqueAgentName(room, rawName, agentId) {
  const base = rawName.trim().replace(/\s+/g, " ");
  let candidate = base || "Agent";
  let suffix = 2;

  while (
    room.agents.some(
      (agent) => agent.id !== agentId && agent.name.toLowerCase() === candidate.toLowerCase(),
    )
  ) {
    candidate = `${base || "Agent"}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function insertMention(agentId) {
  const room = getActiveRoom();
  if (!room) return;

  const agent = room.agents.find((item) => item.id === agentId);
  if (!agent) return;

  const mention = `@${agent.name} `;
  const input = elements.messageInput;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const prefix = input.value.slice(0, start);
  const suffix = input.value.slice(end);
  const needsSpace = prefix.length > 0 && !/\s$/.test(prefix);
  const nextValue = `${prefix}${needsSpace ? " " : ""}${mention}${suffix}`;

  input.value = nextValue;
  input.focus();
  const nextCursor = prefix.length + mention.length + (needsSpace ? 1 : 0);
  input.setSelectionRange(nextCursor, nextCursor);
  updateSendState();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getMentionedAgents(text, room) {
  const { agentIds } = consumeLeadingMentions(text, room);
  return room.agents.filter((agent) => agentIds.has(agent.id));
}

function stripMentions(text, room) {
  return consumeLeadingMentions(text, room).rest.trim();
}

function consumeLeadingMentions(text, room) {
  let rest = String(text || "").trimStart();
  const agentIds = new Set();

  while (rest.startsWith("@")) {
    const match = room.agents
      .map((agent) => {
        const pattern = new RegExp(
          `^@${escapeRegExp(agent.name)}(?=$|\\s|[,.!?，。！？:：；;])`,
          "i",
        );
        const matched = rest.match(pattern);
        return matched ? { agent, length: matched[0].length } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0];

    if (!match) break;
    agentIds.add(match.agent.id);
    rest = rest.slice(match.length).replace(/^[\s,.!?，。！？:：；;]+/, "");
  }

  return { agentIds, rest };
}

function createReplyReference(message) {
  if (!message || typeof message !== "object") return null;
  return {
    id: message.id,
    author: message.author || (message.sender === "user" ? "你" : "Agent"),
    text: message.text || "",
  };
}

function sendMessage() {
  const room = getActiveRoom();
  const text = elements.messageInput.value.trim();
  if (!room || !text) return;

  const mentionedAgents = getMentionedAgents(text, room);
  const message = {
    id: createId("msg"),
    sender: "user",
    author: "你",
    text,
    createdAt: new Date(),
  };

  room.messages.push(message);
  elements.messageInput.value = "";
  updateSendState();
  render();
  persistOpenStateDebounced();

  mentionedAgents.forEach((agent, index) => {
    queueAgentReply(room.id, agent.id, message, index);
  });
}

async function queueAgentReply(roomId, agentId, sourceMessage, index) {
  const room = state.rooms.find((item) => item.id === roomId);
  const agent = room?.agents.find((item) => item.id === agentId);
  if (!room || !agent) return;

  const sourceText = sourceMessage.text || "";
  agent.replying = true;
  const startedAt = Date.now();
  const typingMessage = {
    id: createId("typing"),
    sender: "agent",
    agentId: agent.id,
    author: agent.label,
    text: "正在处理",
    typing: true,
    replyTo: createReplyReference(sourceMessage),
    createdAt: new Date(),
  };

  room.messages.push(typingMessage);
  render();
  persistOpenStateDebounced();

  if (index > 0) {
    await delay(index * 250);
  }

  try {
    const result = await submitAgentJob(room, agent, sourceText, typingMessage.id);
    const latestRoom = state.rooms.find((item) => item.id === roomId);
    const latestAgent = latestRoom?.agents.find((item) => item.id === agentId);
    const latestTyping = latestRoom?.messages.find((message) => message.id === typingMessage.id);
    if (latestTyping) latestTyping.jobId = result.job?.id;
    if (latestAgent) latestAgent.replying = true;
    if (latestRoom && result.room) mergeRoomFromServer(result.room);
    render();
    startStatePolling();
  } catch (error) {
    const latestRoom = state.rooms.find((item) => item.id === roomId);
    const latestAgent = latestRoom?.agents.find((item) => item.id === agentId);

    if (latestAgent) latestAgent.replying = false;
    if (latestRoom && latestAgent) {
      const failedTyping = latestRoom.messages.find((item) => item.id === typingMessage.id);
      if (failedTyping) {
        failedTyping.text = `真实 agent 调用失败：${error.message}`;
        failedTyping.typing = false;
        failedTyping.replyTo = failedTyping.replyTo || createReplyReference(sourceMessage);
      } else {
        latestRoom.messages.push({
          id: typingMessage.id,
          sender: "agent",
          agentId: latestAgent.id,
          author: latestAgent.label,
          text: `真实 agent 调用失败：${error.message}`,
          typing: false,
          replyTo: createReplyReference(sourceMessage),
          createdAt: new Date(),
        });
      }
    }
    render();
    persistOpenStateDebounced();
  }
}

async function submitAgentJob(room, agent, sourceText, typingMessageId) {
  const timeoutMs = Math.min(getClientTimeoutMs(), 15000);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response;
  try {
    response = await fetch(`${API_BASE}/api/agents/${agent.type}/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        agent: {
          id: agent.id,
          type: agent.type,
          name: agent.name,
          label: agent.label,
          contextMode: agent.contextMode || "group",
        },
        room: {
          id: room.id,
          name: room.name,
        },
        workingDir: room.workingDir,
        sessionState: agent.sessionState || {},
        activeRoomId: state.activeRoomId,
        roomSnapshot: serializeRoom(room),
        typingMessageId,
        message: sourceText,
        cleanMessage: stripMentions(sourceText, room),
        conversation: buildConversationSnapshot(room, agent),
      }),
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        `请求超过 ${formatDuration(timeoutMs)}，已停止等待。请检查 Claude/Codex CLI 登录、网络或调大 AGENT_TIMEOUT_MS。`,
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return {
    job: payload.job,
    room: payload.room,
  };
}

async function resolveWorkingDir(pathText) {
  const response = await fetch(`${API_BASE}/api/paths/resolve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      path: pathText || state.defaultWorkingDir,
    }),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.error || `路径不可用：${pathText}`);
  }

  return payload.workingDir;
}

async function browsePath(pathText) {
  const params = new URLSearchParams({
    path: normalizePathText(pathText || state.defaultWorkingDir),
  });
  const response = await fetch(`${API_BASE}/api/paths/browse?${params.toString()}`, {
    cache: "no-store",
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.error || `路径不可读：${pathText}`);
  }

  return payload;
}

async function listCachedRooms(pathText) {
  const params = new URLSearchParams({
    path: pathText || state.defaultWorkingDir,
  });
  const response = await fetch(`${API_BASE}/api/cache/rooms?${params.toString()}`, {
    cache: "no-store",
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.error || "读取缓存失败");
  }

  return Array.isArray(payload.rooms) ? payload.rooms : [];
}

function normalizePathText(value) {
  let text = String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (
    (text.startsWith("\"") && text.endsWith("\"")) ||
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith("`") && text.endsWith("`"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

async function loadSchedules() {
  try {
    const response = await fetch(`${API_BASE}/api/schedules`, {
      cache: "no-store",
    });
    if (!response.ok) return;

    const payload = await response.json();
    state.schedules = Array.isArray(payload.schedules) ? payload.schedules.map(reviveSchedule) : [];
    renderSchedules();
  } catch {
    // Keep the current schedule list if the server is temporarily unavailable.
  }
}

async function createSchedule(schedule) {
  const response = await fetch(`${API_BASE}/api/schedules`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(schedule),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "创建定时任务失败");
  return payload.schedule;
}

async function updateSchedule(scheduleId, fields) {
  const response = await fetch(`${API_BASE}/api/schedules/${encodeURIComponent(scheduleId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(fields),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "更新定时任务失败");
  return payload.schedule;
}

async function deleteSchedule(scheduleId) {
  const response = await fetch(`${API_BASE}/api/schedules/${encodeURIComponent(scheduleId)}`, {
    method: "DELETE",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "删除定时任务失败");
  return payload;
}

async function loadOpenState() {
  try {
    const response = await fetch(`${API_BASE}/api/cache/state`, {
      cache: "no-store",
    });
    if (!response.ok) return false;

    const payload = await response.json();
    if (!payload.exists) return false;

    state.rooms = Array.isArray(payload.rooms) ? payload.rooms.map(reviveRoom) : [];
    state.activeRoomId = state.rooms.some((room) => room.id === payload.activeRoomId)
      ? payload.activeRoomId
      : state.rooms[0]?.id || null;
    setCacheStatus(state.rooms.length > 0 ? "已恢复" : "无打开项");
    return true;
  } catch {
    return false;
  }
}

function persistOpenStateDebounced() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => {
    persistOpenState();
  }, SAVE_DEBOUNCE_MS);
}

async function persistOpenState() {
  try {
    const response = await fetch(`${API_BASE}/api/cache/state`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        activeRoomId: state.activeRoomId,
        rooms: state.rooms.map(serializeRoom),
      }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "保存失败");
    }

    setCacheStatus("已缓存");
  } catch (error) {
    setCacheStatus(error.message || "保存失败", true);
  }
}

async function loadBackendConfig() {
  try {
    const response = await fetch(`${API_BASE}/api/health`, {
      cache: "no-store",
    });
    if (!response.ok) return;

    const payload = await response.json();
    const timeoutMs = Number(payload.agentTimeoutMs);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      state.agentTimeoutMs = timeoutMs;
    }
    if (payload.defaultWorkingDir) {
      state.defaultWorkingDir = payload.defaultWorkingDir;
      state.rooms.forEach((room) => {
        if (!room.workingDir) room.workingDir = payload.defaultWorkingDir;
      });
      render();
    }
  } catch {
    // The first real send will show the connection error if the server is down.
  }
}

function buildConversationSnapshot(room, agent = null) {
  return room.messages
    .filter((message) => !message.typing)
    .filter((message) => !isDirectContextAgent(agent) || isDirectConversationMessage(message, agent, room))
    .map((message) => ({
      sender: message.sender,
      author: message.author || (message.sender === "user" ? "你" : "系统"),
      text: message.text,
    }));
}

function isDirectConversationMessage(message, agent, room) {
  if (message.sender === "user") {
    return getMentionedAgents(message.text || "", room).some((mentioned) => mentioned.id === agent.id);
  }
  return message.sender === "agent" && message.agentId === agent.id;
}

function mergeRoomFromServer(serverRoom) {
  const room = reviveRoom(serverRoom);
  const index = state.rooms.findIndex((item) => item.id === room.id);
  if (index >= 0) {
    state.rooms[index] = room;
  } else {
    state.rooms.push(room);
  }
  if (!state.activeRoomId) state.activeRoomId = room.id;
  return room;
}

async function refreshOpenStateFromServer() {
  try {
    const response = await fetch(`${API_BASE}/api/cache/state`, {
      cache: "no-store",
    });
    if (!response.ok) return;

    const payload = await response.json();
    if (!payload.exists) return;

    const currentActiveRoomId = state.activeRoomId;
    state.rooms = Array.isArray(payload.rooms) ? payload.rooms.map(reviveRoom) : [];
    state.activeRoomId = state.rooms.some((room) => room.id === currentActiveRoomId)
      ? currentActiveRoomId
      : payload.activeRoomId || state.rooms[0]?.id || null;
    render();
    syncPollingWithPendingState();
  } catch {
    // Keep the local view if polling fails.
  }
}

function hasPendingWork() {
  return state.rooms.some(
    (room) =>
      room.agents.some((agent) => agent.replying) ||
      room.messages.some((message) => message.typing),
  );
}

function startStatePolling() {
  if (state.pollTimer) return;
  state.pollTimer = window.setInterval(refreshOpenStateFromServer, STATE_POLL_MS);
}

function stopStatePolling() {
  if (!state.pollTimer) return;
  window.clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function syncPollingWithPendingState() {
  if (hasPendingWork()) startStatePolling();
  else stopStatePolling();
}

function serializeRoom(room) {
  return {
    ...room,
    agents: room.agents.map((agent) => ({
      ...agent,
      replying: false,
      sessionState: agent.sessionState || {},
    })),
    messages: room.messages
      .map((message) => ({
        ...message,
        createdAt: serializeDate(message.createdAt),
      })),
    createdAt: serializeDate(room.createdAt),
    updatedAt: serializeDate(new Date()),
  };
}

function reviveRoom(room) {
  const revived = {
    id: room.id || createId("room"),
    name: room.name || "讨论组",
    workingDir: room.workingDir || state.defaultWorkingDir,
    agents: Array.isArray(room.agents) ? room.agents.map(reviveAgent) : [],
    messages: Array.isArray(room.messages) ? room.messages.map(reviveMessage) : [],
    counters: {
      codex: readCounter(room.counters?.codex),
      claudecode: readCounter(room.counters?.claudecode),
    },
    createdAt: reviveDate(room.createdAt),
    updatedAt: reviveDate(room.updatedAt),
  };

  return ensureRoomCounters(revived);
}

function reviveAgent(agent) {
  const config = agentTypes[agent.type] || agentTypes.codex;
  return {
    id: agent.id || createId(agent.type || "agent"),
    type: agentTypes[agent.type] ? agent.type : "codex",
    name: agent.name || agent.label || config.label,
    label: agent.label || agent.name || config.label,
    initials: agent.initials || config.initials,
    muted: agent.muted !== false,
    replying: Boolean(agent.replying),
    contextMode: agent.contextMode === "direct" ? "direct" : "group",
    sessionState: agent.sessionState || {},
  };
}

function reviveMessage(message) {
  return {
    id: message.id || createId("message"),
    sender: message.sender || "system",
    agentId: message.agentId,
    author: message.author || (message.sender === "user" ? "你" : "系统"),
    text: message.text || "",
    typing: Boolean(message.typing),
    jobId: message.jobId,
    replyTo: reviveReplyReference(message.replyTo),
    createdAt: reviveDate(message.createdAt),
  };
}

function reviveSchedule(schedule) {
  return {
    id: schedule.id || "",
    roomId: schedule.roomId || "",
    roomName: schedule.roomName || "讨论组",
    agentId: schedule.agentId || "",
    agentName: schedule.agentName || "Agent",
    intervalMs: Number(schedule.intervalMs) || 0,
    prompt: schedule.prompt || "",
    active: Boolean(schedule.active),
    createdAt: reviveDate(schedule.createdAt),
    updatedAt: reviveDate(schedule.updatedAt),
    lastRunAt: schedule.lastRunAt ? reviveDate(schedule.lastRunAt) : null,
    nextRunAt: schedule.nextRunAt ? reviveDate(schedule.nextRunAt) : null,
    lastError: schedule.lastError || "",
  };
}

function reviveReplyReference(replyTo) {
  if (!replyTo || typeof replyTo !== "object") return null;
  return {
    id: replyTo.id || "",
    author: replyTo.author || "消息",
    text: replyTo.text || "",
  };
}

function ensureRoomCounters(room) {
  room.agents.forEach((agent) => {
    const match = agent.name.match(/-(\d+)$/);
    const number = match ? Number(match[1]) + 1 : 1;
    if (agent.type === "codex") room.counters.codex = Math.max(room.counters.codex, number);
    if (agent.type === "claudecode") {
      room.counters.claudecode = Math.max(room.counters.claudecode, number);
    }
  });
  return room;
}

function serializeDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function reviveDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function readCounter(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 1;
}

function initializeShellResize() {
  restoreShellSize();
  updateShellSizeClasses();

  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(updateShellSizeClasses);
    observer.observe(elements.shell);
  }

  elements.resizeHandle.addEventListener("pointerdown", (event) => {
    if (window.matchMedia("(max-width: 860px)").matches) return;

    event.preventDefault();
    const startRect = elements.shell.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;

    elements.shell.classList.add("resizing");
    elements.resizeHandle.setPointerCapture(event.pointerId);

    const onPointerMove = (moveEvent) => {
      const nextSize = clampShellSize(
        startRect.width + moveEvent.clientX - startX,
        startRect.height + moveEvent.clientY - startY,
        getShellSizeLimits(),
      );
      applyShellSize(nextSize);
    };

    const onPointerUp = () => {
      elements.shell.classList.remove("resizing");
      elements.resizeHandle.removeEventListener("pointermove", onPointerMove);
      elements.resizeHandle.removeEventListener("pointerup", onPointerUp);
      elements.resizeHandle.removeEventListener("pointercancel", onPointerUp);
      persistShellSize();
    };

    elements.resizeHandle.addEventListener("pointermove", onPointerMove);
    elements.resizeHandle.addEventListener("pointerup", onPointerUp);
    elements.resizeHandle.addEventListener("pointercancel", onPointerUp);
  });

  window.addEventListener("resize", () => {
    const rect = elements.shell.getBoundingClientRect();
    applyShellSize(clampShellSize(rect.width, rect.height, getShellSizeLimits()));
  });
}

function restoreShellSize() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SHELL_SIZE_KEY) || "null");
    if (!saved) return;

    applyShellSize(clampShellSize(saved.width, saved.height, getShellSizeLimits()));
  } catch {
    // Ignore invalid saved sizes.
  }
}

function persistShellSize() {
  const rect = elements.shell.getBoundingClientRect();
  try {
    window.localStorage.setItem(
      SHELL_SIZE_KEY,
      JSON.stringify({
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }),
    );
  } catch {
    // Local storage can be unavailable in private contexts.
  }
}

function applyShellSize(size) {
  elements.shell.style.width = `${Math.round(size.width)}px`;
  elements.shell.style.height = `${Math.round(size.height)}px`;
  updateShellSizeClasses();
}

function clampShellSize(width, height, limits) {
  return {
    width: clamp(Number(width) || limits.defaultWidth, limits.minWidth, limits.maxWidth),
    height: clamp(Number(height) || limits.defaultHeight, limits.minHeight, limits.maxHeight),
  };
}

function getShellSizeLimits() {
  const maxWidth = Math.max(320, window.innerWidth - 32);
  const maxHeight = Math.max(360, window.innerHeight - 32);
  return {
    minWidth: Math.min(560, maxWidth),
    minHeight: Math.min(440, maxHeight),
    maxWidth,
    maxHeight,
    defaultWidth: Math.min(1420, maxWidth),
    defaultHeight: Math.min(860, maxHeight),
  };
}

function updateShellSizeClasses() {
  const rect = elements.shell.getBoundingClientRect();
  elements.shell.classList.toggle("shell-compact", rect.width <= 1080);
  elements.shell.classList.toggle("shell-narrow", rect.width <= 640);
  elements.shell.classList.toggle("shell-short", rect.height <= 620);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getClientTimeoutMs() {
  return Math.max(
    MIN_CLIENT_TIMEOUT_MS,
    Number(state.agentTimeoutMs) + CLIENT_TIMEOUT_PADDING_MS,
  );
}

function formatDuration(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (remainingSeconds === 0) return `${minutes} 分钟`;
  return `${minutes} 分 ${remainingSeconds} 秒`;
}

function formatTypingText(message) {
  return `正在处理（${formatDuration(Date.now() - message.createdAt.getTime())}）`;
}

function formatPath(value) {
  return value || state.defaultWorkingDir || "(默认路径)";
}

function formatTime(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatRelativeTime(date) {
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return "即将执行";
  return `${formatDuration(diffMs)}后`;
}

function renderHighlightedText(text, room) {
  const escaped = escapeHtml(text);
  return room.agents.reduce((value, agent) => {
    const pattern = new RegExp(`@${escapeRegExp(agent.name)}`, "gi");
    return value.replace(pattern, (match) => `<span class="mention">${match}</span>`);
  }, escaped);
}

function renderReplyReference(replyTo) {
  if (!replyTo || (!replyTo.id && !replyTo.text)) return "";
  const text = String(replyTo.text || "").replace(/\s+/g, " ").trim();
  return `
    <div class="reply-reference" data-reply-to-id="${escapeHtml(replyTo.id || "")}">
      <span class="reply-reference-label">回复 ${escapeHtml(replyTo.author || "消息")}</span>
      <span class="reply-reference-text">${escapeHtml(text || "(空消息)")}</span>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderRooms() {
  if (state.rooms.length === 0) {
    elements.roomList.innerHTML = `<div class="empty-state compact">暂无打开的讨论组</div>`;
    return;
  }

  elements.roomList.innerHTML = state.rooms
    .map((room) => {
      const active = room.id === state.activeRoomId ? " active" : "";
      return `
        <article class="room-item${active}" data-action="switch-room" data-room-id="${room.id}">
          <div class="room-item-main">
            <span class="room-item-name">${escapeHtml(room.name)}</span>
            <span class="room-item-path">${escapeHtml(formatPath(room.workingDir))}</span>
          </div>
          <div class="room-item-actions">
            <button class="room-command" type="button" data-action="resume-room" data-room-id="${room.id}" title="从该路径缓存恢复" aria-label="恢复 ${escapeHtml(room.name)}">↻</button>
            <button class="room-command close" type="button" data-action="close-room" data-room-id="${room.id}" title="关闭" aria-label="关闭 ${escapeHtml(room.name)}">×</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderCacheDialog(sourceRoom) {
  elements.cacheDialogTitle.textContent = `选择要恢复的讨论组`;
  elements.cacheRoomChoices.innerHTML = state.cacheDialog.rooms
    .map((room) => {
      const messageCount = room.messages.filter((message) => message.sender === "user").length;
      const agentCount = room.agents.length;
      return `
        <article class="cache-choice">
          <div class="cache-choice-main">
            <span class="cache-choice-name">${escapeHtml(room.name)}</span>
            <span class="cache-choice-meta">${escapeHtml(formatPath(room.workingDir))}</span>
            <span class="cache-choice-meta">${messageCount} 条用户消息 · ${agentCount} 个 agent</span>
          </div>
          <button class="secondary-action" type="button" data-action="restore-cached-room" data-room-id="${room.id}">恢复</button>
        </article>
      `;
    })
    .join("");

  if (sourceRoom) {
    elements.cacheDialogTitle.textContent = `从 ${sourceRoom.name} 的路径恢复`;
  }
}

function renderPathDialog() {
  elements.pathDialogCurrent.textContent = state.pathDialog.currentPath || "未选择";
  if (state.pathDialog.currentPath) elements.pathDialogInput.value = state.pathDialog.currentPath;
  elements.pathBack.disabled = state.pathDialog.historyIndex <= 0;
  elements.pathForward.disabled =
    state.pathDialog.historyIndex < 0 ||
    state.pathDialog.historyIndex >= state.pathDialog.history.length - 1;
  elements.pathParent.disabled = !state.pathDialog.parentPath;
  elements.chooseCurrentPath.disabled = !state.pathDialog.currentPath;
  elements.openPathInput.disabled = !normalizePathText(elements.pathDialogInput.value);
  elements.pathHistoryList.innerHTML = state.pathDialog.history.length
    ? state.pathDialog.history
        .map((historyPath, index) => {
          const active = index === state.pathDialog.historyIndex ? " active" : "";
          return `<button class="path-history-item${active}" type="button" data-action="open-history-path" data-history-index="${index}" title="${escapeHtml(historyPath)}">${escapeHtml(historyPath)}</button>`;
        })
        .join("")
    : `<span class="path-dialog-status">暂无历史路径</span>`;

  const roots = state.pathDialog.tree.roots.length
    ? state.pathDialog.tree.roots
    : getPathAncestors(state.pathDialog.currentPath).slice(0, 1);
  elements.pathDirectoryList.innerHTML = roots.length
    ? roots.map((rootPath) => renderPathTreeNode(rootPath, 0)).join("")
    : `<div class="empty-state compact">没有可进入的目录</div>`;
}

function renderPathTreeNode(pathText, depth) {
  const node = getOrCreatePathTreeNode(pathText);
  const isCurrent = normalizeTreePath(node.path) === normalizeTreePath(state.pathDialog.currentPath);
  const activeClass = isCurrent ? " active" : "";
  const expandedClass = node.expanded ? " expanded" : "";
  const hasKnownChildren = node.directories.length > 0;
  const canToggle = !node.loaded || hasKnownChildren || Boolean(node.error);
  const toggleText = node.expanded ? "▾" : "▸";
  const toggleButton = canToggle
    ? `<button class="path-tree-toggle" type="button" data-action="toggle-tree-path" data-path="${escapeHtml(node.path)}" aria-label="${node.expanded ? "收起" : "展开"} ${escapeHtml(node.name)}">${toggleText}</button>`
    : `<span class="path-tree-toggle placeholder"></span>`;
  const row = `
    <div class="path-tree-row${activeClass}${expandedClass}" style="--depth: ${depth}">
      ${toggleButton}
      <button class="path-tree-name" type="button" data-action="open-tree-path" data-path="${escapeHtml(node.path)}" title="${escapeHtml(node.path)}">
        <span class="path-tree-label">${escapeHtml(node.name)}</span>
        <span class="path-tree-full">${escapeHtml(node.path)}</span>
      </button>
    </div>
  `;

  if (!node.expanded) return row;
  if (node.error) {
    return `${row}<div class="path-tree-error" style="--depth: ${depth + 1}">${escapeHtml(node.error)}</div>`;
  }
  if (!node.loaded) {
    return `${row}<div class="path-tree-loading" style="--depth: ${depth + 1}">读取中</div>`;
  }
  if (node.directories.length === 0) {
    return `${row}<div class="path-tree-empty" style="--depth: ${depth + 1}">没有子目录</div>`;
  }

  return `${row}${node.directories
    .map((directory) => renderPathTreeNode(directory.path, depth + 1))
    .join("")}`;
}

function renderRoomSettings(room) {
  elements.roomTitle.textContent = room ? room.name : "讨论组";
  elements.roomPathLabel.textContent = room ? formatPath(room.workingDir) : "";
  elements.roomNameInput.value = room?.name || "";
  elements.roomPathInput.value = room?.workingDir || "";
}

function renderAgents() {
  const room = getActiveRoom();
  const agents = room?.agents || [];
  elements.agentCount.textContent = agents.length.toString();
  elements.mutedStatus.textContent = agents.length === 0 ? "暂无 agent" : `${agents.length} 个静默`;

  if (!room) {
    elements.agentList.innerHTML = `<div class="empty-state">暂无讨论组</div>`;
    elements.mentionStrip.innerHTML = "";
    elements.replyHint.textContent = "先创建讨论组";
    return;
  }

  if (agents.length === 0) {
    elements.agentList.innerHTML = `<div class="empty-state">创建 Codex 或 Claude Code agent</div>`;
    elements.mentionStrip.innerHTML = "";
    elements.replyHint.textContent = "先创建 agent，再用 @ 点名";
    return;
  }

  elements.agentList.innerHTML = agents
    .map((agent) => {
      const config = agentTypes[agent.type];
      const modeLabel = isDirectContextAgent(agent) ? "独立" : config.label;
      return `
        <article class="agent-card">
          <div class="agent-avatar ${agent.type}">${config.initials}</div>
          <div class="agent-meta">
            <div class="agent-name-row">
              <input class="agent-name-input" type="text" value="${escapeHtml(agent.label)}" data-action="rename-agent" data-agent-id="${agent.id}" aria-label="Agent 名称" />
              <span class="agent-badge">${agent.replying ? "回复中" : modeLabel}</span>
            </div>
            <span class="agent-handle">@${escapeHtml(agent.name)}${isDirectContextAgent(agent) ? " · 独立上下文" : ""}</span>
          </div>
          <div class="agent-actions">
            <button class="agent-command" type="button" data-action="mention" data-agent-id="${agent.id}" title="@${escapeHtml(agent.name)}" aria-label="@${escapeHtml(agent.name)}">@</button>
            <button class="agent-command remove" type="button" data-action="remove" data-agent-id="${agent.id}" title="移除" aria-label="移除 ${escapeHtml(agent.label)}">×</button>
          </div>
        </article>
      `;
    })
    .join("");

  elements.mentionStrip.innerHTML = agents
    .map(
      (agent) =>
        `<button class="mention-chip" type="button" data-action="mention" data-agent-id="${agent.id}"><span>@${escapeHtml(agent.name)}</span></button>`,
    )
    .join("");
  elements.replyHint.textContent = `路径：${formatPath(room.workingDir)}`;
}

function renderSchedules() {
  if (state.schedules.length === 0) {
    elements.scheduleList.innerHTML = `<div class="empty-state compact">暂无定时任务</div>`;
    return;
  }

  elements.scheduleList.innerHTML = state.schedules
    .map((schedule) => {
      const status = schedule.active ? "运行中" : "已停止";
      const statusClass = schedule.active ? " active" : "";
      const nextText = schedule.active && schedule.nextRunAt
        ? `下次：${formatRelativeTime(schedule.nextRunAt)}`
        : "未计划";
      return `
        <article class="schedule-card${statusClass}">
          <div class="schedule-card-head">
            <span class="schedule-target">${escapeHtml(schedule.agentName)}</span>
            <span class="schedule-state">${status}</span>
          </div>
          <span class="schedule-meta">${escapeHtml(schedule.roomName)} · 每 ${formatDuration(schedule.intervalMs)}</span>
          <p class="schedule-prompt">${escapeHtml(schedule.prompt)}</p>
          <span class="schedule-meta">${escapeHtml(nextText)}</span>
          ${
            schedule.lastError
              ? `<span class="schedule-error">${escapeHtml(schedule.lastError)}</span>`
              : ""
          }
          <div class="schedule-actions">
            <button class="secondary-action" type="button" data-action="edit-schedule" data-schedule-id="${escapeHtml(schedule.id)}">编辑</button>
            <button class="secondary-action" type="button" data-action="copy-schedule" data-schedule-id="${escapeHtml(schedule.id)}">复制</button>
            <button class="secondary-action" type="button" data-action="toggle-schedule" data-schedule-id="${escapeHtml(schedule.id)}" data-active="${schedule.active ? "false" : "true"}">${schedule.active ? "停止" : "开始"}</button>
            <button class="room-command close" type="button" data-action="delete-schedule" data-schedule-id="${escapeHtml(schedule.id)}" aria-label="删除定时任务">×</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderMessages() {
  const room = getActiveRoom();
  const messageList = elements.messageList;
  const previousScrollTop = messageList.scrollTop;
  const shouldStickToBottom = isMessageListNearBottom();

  if (!room || room.messages.length === 0) {
    messageList.innerHTML = `
      <div class="message-row system">
        <div class="bubble">讨论组已就绪</div>
      </div>
    `;
    return;
  }

  messageList.innerHTML = room.messages
    .map((message) => {
      if (message.sender === "system") {
        return `
          <div class="message-row system">
            <div class="bubble">${escapeHtml(message.text)}</div>
          </div>
        `;
      }

      const agent = room.agents.find((item) => item.id === message.agentId);
      const avatar = message.sender === "user" ? "你" : agentTypes[agent?.type || "codex"].initials;
      const rowClass = `${message.sender}${message.typing ? " typing" : ""}`;
      const messageText = message.typing ? formatTypingText(message) : message.text;
      const replyReference = renderReplyReference(message.replyTo);

      return `
        <article class="message-row ${rowClass}" data-message-id="${escapeHtml(message.id)}">
          <div class="message-avatar">${escapeHtml(avatar)}</div>
          <div class="bubble">
            <div class="bubble-head">
              <span>${escapeHtml(message.author)}</span>
              <time>${formatTime(message.createdAt)}</time>
            </div>
            ${replyReference}
            <div class="bubble-text">${renderHighlightedText(messageText, room)}</div>
          </div>
        </article>
      `;
    })
    .join("");

  if (shouldStickToBottom) {
    messageList.scrollTop = messageList.scrollHeight;
  } else {
    messageList.scrollTop = Math.min(
      previousScrollTop,
      Math.max(0, messageList.scrollHeight - messageList.clientHeight),
    );
  }
}

function isMessageListNearBottom() {
  const messageList = elements.messageList;
  const distanceToBottom =
    messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight;
  return distanceToBottom <= AUTO_SCROLL_THRESHOLD_PX;
}

function setPathStatus(text, isError = false) {
  elements.pathStatus.textContent = text;
  elements.pathStatus.classList.toggle("error", isError);
}

function setCacheStatus(text, isError = false) {
  elements.cacheStatus.textContent = text;
  elements.cacheStatus.classList.toggle("error", isError);
}

function setPathDialogStatus(text, isError = false) {
  elements.pathDialogStatus.textContent = text;
  elements.pathDialogStatus.classList.toggle("error", isError);
}

function setScheduleStatus(text, isError = false) {
  elements.scheduleStatus.textContent = text;
  elements.scheduleStatus.classList.toggle("error", isError);
}

function updateClock() {
  elements.clock.textContent = formatTime(new Date());
}

function updateSendState() {
  elements.sendMessage.disabled = !getActiveRoom() || elements.messageInput.value.trim().length === 0;
}

function render() {
  const room = getActiveRoom();
  renderRooms();
  renderRoomSettings(room);
  renderAgents();
  renderSchedules();
  renderMessages();
  updateSendState();
}

function createDefaultRoom() {
  const initialRoom = createRoom({ name: "讨论组 1", workingDir: state.defaultWorkingDir });
  state.rooms.push(initialRoom);
  state.activeRoomId = initialRoom.id;
  addAgentToRoom(initialRoom, "codex", true);
  addAgentToRoom(initialRoom, "claudecode", true);
  initialRoom.messages.push({
    id: createId("system"),
    sender: "system",
    text: "讨论组已创建",
    createdAt: new Date(),
  });
}

async function initialize() {
  updateClock();
  render();
  await loadBackendConfig();
  const restored = await loadOpenState();
  if (!restored) {
    createDefaultRoom();
    await persistOpenState();
  }
  await loadSchedules();
  render();
  syncPollingWithPendingState();
}

function keepDialogOpenOnBackdropClick(event) {
  if (event.target === event.currentTarget) {
    event.stopPropagation();
  }
}

elements.addAgent.addEventListener("click", () => addAgent());
elements.createRoom.addEventListener("click", createRoomFromForm);
elements.createSchedule.addEventListener("click", () => openScheduleDialog());
elements.saveSchedule.addEventListener("click", saveSchedule);
elements.scheduleAgent.addEventListener("change", persistScheduleDraft);
elements.scheduleInterval.addEventListener("input", persistScheduleDraft);
elements.scheduleIntervalUnit.addEventListener("change", persistScheduleDraft);
elements.scheduleFirstRunMode.addEventListener("change", () => {
  syncScheduleFirstRunControls();
  persistScheduleDraft();
});
elements.scheduleFirstRunDelay.addEventListener("input", persistScheduleDraft);
elements.scheduleFirstRunUnit.addEventListener("change", persistScheduleDraft);
elements.schedulePrompt.addEventListener("input", persistScheduleDraft);
elements.saveRoomSettings.addEventListener("click", saveActiveRoomSettings);
elements.selectNewRoomPath.addEventListener("click", () => openPathDialog("new-room"));
elements.selectRoomPath.addEventListener("click", () => openPathDialog("room-settings"));
elements.pathBack.addEventListener("click", () => movePathHistory(-1));
elements.pathForward.addEventListener("click", () => movePathHistory(1));
elements.pathParent.addEventListener("click", openPathParent);
elements.openPathInput.addEventListener("click", openTypedPath);
elements.pathDialogInput.addEventListener("input", () => {
  elements.openPathInput.disabled = !normalizePathText(elements.pathDialogInput.value);
});
elements.pathDialogInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    openTypedPath();
  }
});
elements.chooseCurrentPath.addEventListener("click", chooseCurrentPath);
elements.sendMessage.addEventListener("click", sendMessage);
elements.messageInput.addEventListener("input", updateSendState);
elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;

  if (target.dataset.action === "switch-room") {
    activateRoom(target.dataset.roomId);
  }

  if (target.dataset.action === "resume-room") {
    resumeRoom(target.dataset.roomId);
  }

  if (target.dataset.action === "restore-cached-room") {
    restoreCachedRoom(target.dataset.roomId);
  }

  if (target.dataset.action === "open-path") {
    loadPathDialog(target.dataset.path, { pushHistory: true });
  }

  if (target.dataset.action === "open-history-path") {
    openPathHistoryItem(target.dataset.historyIndex);
  }

  if (target.dataset.action === "toggle-tree-path") {
    togglePathTreeNode(target.dataset.path);
  }

  if (target.dataset.action === "open-tree-path") {
    loadPathDialog(target.dataset.path, { pushHistory: true });
  }

  if (target.dataset.action === "close-room") {
    closeRoom(target.dataset.roomId);
  }

  if (target.dataset.action === "mention") {
    insertMention(target.dataset.agentId);
  }

  if (target.dataset.action === "remove") {
    removeAgent(target.dataset.agentId);
  }

  if (target.dataset.action === "toggle-schedule") {
    updateSchedule(target.dataset.scheduleId, {
      active: target.dataset.active === "true",
    })
      .then(loadSchedules)
      .catch((error) => setScheduleStatus(error.message || "更新失败", true));
  }

  if (target.dataset.action === "edit-schedule") {
    openScheduleDialog(target.dataset.scheduleId, "edit");
  }

  if (target.dataset.action === "copy-schedule") {
    openScheduleDialog(target.dataset.scheduleId, "copy");
  }

  if (target.dataset.action === "delete-schedule") {
    deleteSchedule(target.dataset.scheduleId)
      .then(loadSchedules)
      .catch((error) => setScheduleStatus(error.message || "删除失败", true));
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (target.dataset?.action === "rename-agent") {
    renameAgent(target.dataset.agentId, target.value);
  }
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (event.key === "Enter" && target.dataset?.action === "rename-agent") {
    event.preventDefault();
    target.blur();
  }
});

elements.closeCacheDialog.addEventListener("click", closeCacheDialog);
elements.cacheDialog.addEventListener("click", keepDialogOpenOnBackdropClick);
elements.closePathDialog.addEventListener("click", closePathDialog);
elements.pathDialog.addEventListener("click", keepDialogOpenOnBackdropClick);
elements.closeScheduleDialog.addEventListener("click", closeScheduleDialog);
elements.scheduleDialog.addEventListener("click", keepDialogOpenOnBackdropClick);

initializeShellResize();
initialize();
window.setInterval(updateClock, 30000);
window.setInterval(() => {
  loadSchedules();
  if (state.schedules.some((schedule) => schedule.active)) {
    refreshOpenStateFromServer();
  }
}, SCHEDULE_REFRESH_MS);
window.setInterval(() => {
  if (hasPendingWork()) renderMessages();
}, 1000);
