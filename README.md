# Agent 群聊

一个本地 Web 群聊界面，用来把多个 Codex / Claude Code agent 放进同一个讨论组。

## 使用

```bash
npm start
```

然后打开：

```text
http://localhost:5173
```

## 当前行为

- 可以创建多个 Codex 或 Claude Code agent。
- 可以创建多个讨论组，并为每个讨论组设置名称和运行路径。
- 已有讨论组可以改名或切换运行路径，消息记录会继续保留并作为后续 agent 上下文。
- 讨论组会缓存：服务重启后会恢复左侧打开中的讨论组。
- 每个路径下会保存有用户消息的讨论组历史和 agent session 状态；空历史不会写入路径缓存。
- 左侧讨论组支持关闭和恢复：关闭只隐藏当前打开项，不删除路径缓存；恢复会弹出该路径下所有可恢复讨论组供选择。
- agent 调用由后端后台任务执行；关闭前端页面不会中断正在运行的 Codex / Claude Code，重新打开后会继续显示处理中状态或最终回复。
- 如果 Web 服务本身重启或关闭导致后台任务丢失，重新读取状态时会把对应“正在处理”消息标记为已中断，避免无限显示处理中。
- Codex / Claude Code agent 可以在左侧列表里直接改名，新的名称会成为 `@` 点名名称。
- agent 进入讨论组后默认静默。
- 用户消息里只有明确 `@AgentName` 的 agent 会回复。
- agent 回复里也可以明确 `@OtherAgent` 分配任务；后端会继续调用被 @ 的 agent，并把处理中状态和最终回复写回同一个讨论组。
- agent 回复会显示它回复的是哪条消息；“正在处理”的消息框会在任务完成后原地更新为最终回复，不会追加第二个回复框。
- 右侧可以新建定时任务：选择时间间隔、目标 agent 和 prompt 后会立即执行一次，之后后端会按间隔继续向该 agent 发送 prompt；任务支持开始、停止和删除。
- 被 @ 的 agent 会通过本地后端调用真实 CLI：
  - Codex: `codex exec`
  - Claude Code: `claude --print`
- agent 返回内容会作为群聊消息回流到讨论组中。
- agent 运行目录是当前讨论组设置的路径，默认是当前项目目录。
- 前端会显示 agent 已等待时间；后端会按配置的间隔检查后台 job 是否仍在运行，运行中则继续等待。
- 如果浏览器中断请求，后端会取消对应 agent 调用并清理子进程树。

## 配置

可用环境变量：

- `PORT`：Web 服务端口，默认 `5173`
- `AGENT_TIMEOUT_MS`：后台 agent job 存活检查间隔，默认 `300000`。检查时 job 仍在运行则继续等待；job 已丢失才按超时失败处理。
- `CODEX_COMMAND`：Codex CLI 命令，默认 Windows 为 `codex.cmd`，其他系统为 `codex`
- `CLAUDE_COMMAND`：Claude Code CLI 命令，默认 Windows 为 `claude.cmd`，其他系统为 `claude`
- `AGENTDISCUSSION_STATE_FILE`：打开中的讨论组状态文件，默认 `.mca/open-rooms.json`
- `AGENTDISCUSSION_SCHEDULE_FILE`：定时任务状态文件，默认 `.mca/schedules.json`

本地需要先完成 Codex CLI 和 Claude Code CLI 的登录或 API key 配置。
Codex 后端调用不再指定 `--sandbox`，使用当前 Codex CLI 的默认沙箱策略。
如果 Web 服务当前以 root/sudo 环境运行，后端会自动使用 Claude Code 的 `acceptEdits` 权限模式，避免触发 Claude Code 对 `bypassPermissions` 的安全拒绝；非 root 启动时仍会启用 `bypassPermissions`。
`acceptEdits` 模式下后端默认额外允许 Claude Code 执行 `Bash(mkdir:*)`、`Bash(python3:*)` 和 `Bash(python:*)`，用于定时任务抓取数据和落盘文件；需要调整时可设置 `CLAUDE_ALLOWED_TOOLS`，用逗号分隔工具规则。
如果确认要开启 Claude Code 的危险免确认模式，需要用普通用户启动 Web 服务并设置 `CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=1`。Claude Code 会拒绝 root/sudo 进程使用该模式；后端会自动传入最近的 `.claude/settings.json`，也可以用 `CLAUDE_SETTINGS_FILE=/path/to/settings.json` 指定。

## 讨论组路径
新建讨论组和修改已有讨论组路径时，路径输入框旁都有“选择”按钮。点击后会打开路径选择窗口，可以从当前路径进入子目录、返回上一级，并用后退/前进在已浏览路径间切换；选择后仍会走后端目录校验。

新建讨论组或保存已有讨论组设置时，后端会校验路径必须存在且是目录。路径切换后不会清空当前讨论组消息；后续 Codex / Claude Code 调用会在新路径下启动，并继续收到该讨论组最近消息作为上下文。

## 缓存

- 打开中的讨论组状态保存到项目目录的 `.mca/open-rooms.json`，服务启动后前端会读取并复原左侧列表。
- 定时任务状态保存到项目目录的 `.mca/schedules.json`，服务启动和页面重新打开后会恢复右侧定时任务列表；启用中的任务会继续调度。
- 有用户消息的讨论组会额外保存到对应运行路径下的 `.agentdiscussion-cache/rooms.json`。
- 关闭讨论组只会更新打开列表，不会删除 `.agentdiscussion-cache/rooms.json` 里的历史。
- `↻` 恢复按钮会读取该讨论组当前路径下的所有缓存讨论组，弹窗选择后把历史和 agent session 状态恢复到界面中继续使用。
- 正在运行的 agent 任务会保留在后端；前端重新打开后通过缓存状态轮询恢复 typing 状态，并在任务完成后显示结果。

## 排查

如果 Claude Code 一直显示“正在处理”，优先检查：

- 运行 `claude --print "你好"` 是否能在终端直接返回。
- Claude Code 是否已登录，或 `ANTHROPIC_API_KEY` / apiKeyHelper 是否可用。
- 网络代理是否允许 Claude Code CLI 访问模型服务。
- 默认 agent job 存活检查间隔是 5 分钟；长任务只要后台 job 仍在运行就会继续等待，不会因为到达该时间自动重启。
- 如果进程异常退出或返回空响应，后端仍会清空旧 session 状态并重启该 agent 重试一次。
