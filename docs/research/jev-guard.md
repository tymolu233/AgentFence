# jev-guard 调研报告（AgentFence 任务 A1）

- **仓库**：https://github.com/leepokai/jev-guard
- **Commit**：`94996ea80b6b308327ac2077706a29ce6abd3ba0`（2026-09-18，README: auto-mode framing…）
- **License**：MIT（Copyright (c) 2026 leepokai）
- **语言/运行时**：JavaScript（ESM，Node ≥20.3，零依赖）+ 一个 TS 扩展（pi）；npm 包 `jev-guard` v0.3.1
- **定位**：挂在各家 Coding Agent 的 Hook 上的安全网关，把判定外包给 Jev（TypeSafe 的结构化评估模型，返回校准概率而非文本）。源码仅 ~1000 行：`src/jev.js`（API 客户端）、`src/guard.js`（问题集 + 策略）、`src/context.js`+`src/session.js`（会话上下文）、`src/hook.js`（CLI hook 适配）、`src/opencode.js`、`src/acp.js`、`src/skills.js`（指令文件扫描）、`extensions/jev-guard.ts`（pi）。

## Tool Call 数据结构

jev-guard 不做统一抽象层，而是**一个 hook 进程识别多种宿主 payload**（`src/hook.js:1-3`）。入口从 stdin 读 JSON，按 `hook_event_name` 分方言（`src/hook.js:25-27`）：

- **Claude Code / Codex / Copilot**（PascalCase 事件）：`{hook_event_name, session_id, tool_name, tool_input, tool_response, transcript_path, cwd, prompt}`。Copilot 多一个 ISO `timestamp`，Codex 多 `turn_id`+`model`，靠这个区分三家（`src/hook.js:11-16`）。
- **Gemini CLI**：`BeforeTool/AfterTool/BeforeAgent` 事件，同样 `tool_name`/`tool_input` 字段（`src/hook.js:101-111`）。
- **Cursor**（camelCase 事件）：`beforeShellExecution` 给 `{command, cwd}`；`beforeMCPExecution` 给 `{mcp_server_name, tool_name}`，合成工具名 `mcp__<server>__<tool>`；`preToolUse` 给 `tool_name`+`tool_input`（字符串需二次 JSON.parse）；还附带 `agent_message`（agent 当前陈述的意图）（`src/hook.js:115-123`）。
- **OpenCode**（进程内插件）：`tool.execute.before` 的 `input.tool` + `output.args`；`permission.ask` 从 `metadata/pattern/title` 重建参数（`src/opencode.js:25-39`）。
- **ACP 代理**（JSON-RPC stdio 代理）：把 `terminal/create` 归一成 `{tool:"Bash", input:{command,cwd}}`，`fs/write_text_file` 归一成 `{tool:"Write", input:{file_path,content}}`（`src/acp.js:44-49`）。

进入判定前统一归一为 `{agent, tool, input, cwd, context}`（`src/guard.js:130-134`）。**session context 的结构**在 `src/context.js:24-29`：

```
user_recent_messages      最近 3 条用户消息（截 700 字符）
assistant_intent          agent 最近一段自述意图
recent_tool_calls         最近 6 次调用及其判定级别
flagged_untrusted_content 最近 5 条注入命中（kind/来源/p 值/摘录）
```

context 来源三路合并：① 每会话 JSON 文件 `~/.jev-guard/sessions/<sha1(sessionId)前16位>.json`（`src/session.js:13-15`，容量上限 prompts 6 / calls 12 / flags 10，`src/session.js:10`），由各宿主的 prompt hook 写入（`src/hook.js:52-54`）；② Claude 风格 JSONL transcript 尾部 256KB 解析（`src/context.js:35-58`）；③ 适配器自带消息（pi/OpenCode/ACP 的 `messagesFrom`，`src/context.js:70-80`）。关键原则：**tool result 里的内容永远不算"用户说的话"**（`src/context.js:34` 注释、`src/guard.js:81`）。

## 决策流程

挂接点：宿主配置里注册命令 hook `node src/cli.js hook`，stdin/stdout 传 JSON（`hooks/hooks.json:4-15` 注册了 PreToolUse/PostToolUse/UserPromptSubmit/SessionStart/InstructionsLoaded 等 8 种事件）。判定分三类，策略全部在代码里、Jev 只回答窄问题（`src/guard.js:1`）：

**1. 动作判定（PreToolUse 等）**：`assessAction`（`src/guard.js:130-146`）。先短路：只读工具白名单（read/grep/glob/webfetch 等 20+ 个名字，`src/guard.js:103-105`）和 `JEV_GUARD_SKIP_TOOLS` 直接放行、不调 API。然后一次性向 Jev 提 4 个类型化问题（`src/guard.js:60-99`）：

- `risk`（Score 0–3）：只读可逆 → 易撤销 → 难撤销/越出工作区 → 破坏性
- `approval`（Noul）：谨慎的资深工程师是否会要求人工批准
- `user_requested`（Noul）：用户最近的本人消息是否明确要了这个操作
- `from_untrusted`（Noul）：该调用是否在执行"从不可信内容里植入的指令"

纯函数 `decide`（`src/guard.js:119-127`）按序判定，阈值全部可用环境变量调（`src/guard.js:111-115`）：

```
deny   if from_untrusted.p ≥ 0.70   ← 注入驱动的调用一票否决，最先判
deny   if risk ≥ 2.5
allow  if (risk ≥ 1.5 or approval ≥ 0.75) and user_requested.p ≥ 0.85  ← 用户亲口要的降级
ask    if risk ≥ 1.5 or approval ≥ 0.75
allow  otherwise
```

**落地方式因宿主能力而异**（`src/hook.js:79-123`）：Claude Code 回 `permissionDecision: deny|ask`；Codex/Gemini 没有 ask，降级为"警告 systemMessage 放行"；Cursor 回 `{permission: allow|ask|deny}`（`preToolUse` 不支持 ask，ask 放行）；OpenCode 用 `throw` 阻断 + `permission.ask` 映射 `output.status`（`src/opencode.js:29,37`）；pi 弹 `ctx.ui.confirm`，无 UI 时 ask 直接 block（`extensions/jev-guard.ts:24-27`）；ACP 用 `session/request_permission` 向客户端要批准，拒绝则回 JSON-RPC error -32000（`src/acp.js:56-66`）。

**2. 内容扫描（PostToolUse 等）**：`scanContent`（`src/guard.js:149-163`）。跳过本地编辑类工具结果（NEVER_EXTERNAL，`src/guard.js:106-107`）、<200 字符的结果；>60k 字符头尾截断（注入爱藏在结尾，`src/guard.js:215-219`）。问 `directed`（是否含针对 AI 的指令）+`kind`（injection/canary/discussion/benign），`directed.p ≥ 0.6 且 kind ∈ {injection, canary}` 时命中（`src/guard.js:157`）。命中后三件事：① 用 `excerpt` 提取最可疑的行存入 session 的 flags（`src/guard.js:196-200`、`src/hook.js:40`），供后续 `from_untrusted` 比对；② 把警告文本**前置注入 tool result** 喂回给 agent（`src/opencode.js:50`、`src/acp.js:97`）；③ Claude 宿主回 `decision:"block"` 让模型看到警告。

**3. 指令文件扫描**：SKILL.md/CLAUDE.md/AGENTS.md/rules 等用独立问题集（INSTRUCTION_QUESTIONS，`src/guard.js:32-58`）——因为这类文件本来就该含指令，问的是"是否有安装者意料之外的行为"（exfiltration/covert_execution/instruction_override/canary/unrelated_side_effects/clean）。严重类 p≥0.45 命中，`unrelated_side_effects` 需 p≥0.8（`src/guard.js:169-172`）。按内容 sha1 缓存答案、判定实时重算（`src/skills.js:37-49`），SessionStart 和首次 prompt 时全量 sweep（`src/hook.js:45-51`）。

**Jev 调用层**（`src/jev.js:29-67`）：单次 POST `{state, questions}` 到 api.typesafe.ai 或 Vercel AI Gateway；20s 总预算内含 2 次退避重试（宿主 ~30s 杀 hook）；返回答案带 per-question confidence。**默认 fail-open**：API 挂了 stderr 警告并放行，`JEV_GUARD_FAIL_CLOSED=1` 才改为 deny（`src/hook.js:138-147`）。

## 可借鉴点 / 不可照抄点

**可借鉴（对 AgentFence Go 核心）：**

1. **策略与模型解耦**：Jev 只答类型化窄问题（Score/Noul/Choice），deny/ask/allow 是纯函数 `decide`，可单测、可用 env 调阈值（`src/guard.js:119-127`）。AgentFence 应把"评分器"做成接口，策略层放 Go 代码。
2. **三档判定的逃逸设计**：`user_requested` 只把 ask 降 allow、**永不解除 deny**；`from_untrusted` 一票否决在最前面（`src/guard.js:120-123`）。这个优先级顺序值得直接采用。
3. **会话上下文即判定输入**：轻量 per-session JSON（容量封顶、sha1 命名、0600 权限、7 天清理，`src/session.js:10,29,50-58`），让"用户刚说过 force push"成为可判定的信号。Go 侧可用同样的有界环形结构。
4. **注入命中→摘录→后续比对**的闭环：flags 带 excerpt 进 context，`from_untrusted` 拿它对照新调用（`src/context.js:28`、`src/guard.js:87-98`）——这是"跨调用追踪投毒"的最小实现。
5. **结果扫描的工程细节**：<200 字符跳过、头尾截断 60k、NEVER_EXTERNAL 白名单、discussion 类不算注入（避免误报安全文档）。
6. **适配器矩阵教训**：每个宿主的 ask 能力不同（Codex/Gemini 无 ask、Cursor preToolUse 无 ask、pi 无 UI 时 block），适配层必须按宿主能力降级而不是假设三档都可用。
7. **fail-open 默认 + FAIL_CLOSED 开关**、20s 预算内含重试（hook 宿主有硬超时）——网关延迟预算设计的直接参照。
8. **License 约束**：MIT，可自由借鉴代码与思路，保留版权声明即可；无专利/ copyleft 障碍。

**不可照抄：**

1. **判定完全外包给云端 Jev**：每次工具调用都 POST 到第三方 API（tool result 内容也上传），零本地规则兜底。AgentFence 若定位本地/企业网关，需要本地规则引擎为主、LLM 评分为辅；且 Jev 是专有托管服务，强依赖它有可用性与合规风险。
2. **每调用一次远程 RTT**（实测 ~580ms–750ms），README 自述"guardrail, not a sandbox"——它承认 hook 可绕过、模型会判错。AgentFence 若要做执行层网关，不能停留在 hook 信任模型。
3. **工具名白名单靠字符串匹配**（READ_ONLY/NEVER_EXTERNAL，`src/guard.js:103-107`），跨宿主工具命名靠硬编码映射，脆弱；AgentFence 应用结构化工具能力声明（read/write/network 维度）。
4. **无鉴权/多租户/审计持久化**：session 文件即全部状态，无签名、无防篡改；企业场景不够。
5. **Node 单文件脚本形态**：每次 hook 冷启动一个 Node 进程，Go 长驻网关的架构（低延迟、连接复用、策略热更新）是天然差异化方向。
