# AgentFence 适配层（任务 B9 + C2）

把各家 Coding Agent 的 pre-tool-use 挂接点接到 AgentFence 引擎上。
适配器只做协议转换：宿主 payload → 统一 `ToolCall` → `engine.check` →
把 `Decision` 回译为宿主响应；判定逻辑只在核心（`docs/architecture.md`
"Agent 适配"）。方言依据：`docs/research/jev-guard.md`（Copilot / pi /
ACP 直接参照 jev-guard 源码，Grok CLI 调研见 `grok-cli/README.md`）。

## 结构

```
core/          共享归一层：payload 守卫 → 方言识别 → 归一化 → 能力矩阵 → 回译
claude-code/   PreToolUse hook（stdin/stdout）
codex/         PreToolUse hook（payload 同 Claude 形，多 turn_id+model）
gemini-cli/    BeforeTool hook（stdin/stdout）
cursor/        beforeShellExecution / beforeMCPExecution / preToolUse 三事件
opencode/      进程内插件（tool.execute.before + permission.ask）
copilot/       PreToolUse hook（同 Claude 形，多 ISO timestamp；顶层双写）
pi/            进程内扩展（tool_call 事件 + ctx.ui.confirm 审批）
acp/           JSON-RPC stdio 代理（terminal/create + fs/write_text_file）
grok-cli/      PreToolUse hook（superagent-ai/grok-cli；approve/block 两档）
```

## 构建与安装

```bash
npm run build && npx tsc -p integrations/tsconfig.build.json
```

产物在 `dist/integrations/<host>/`（与 `dist/src/` 同树）。各宿主的 hooks
配置片段见对应目录 README.md。配置加载复用 `src/cli/config.ts`：
`AGENTFENCE_CONFIG` 环境变量 → cwd 下 `agentfence.yaml` → 仓库内置默认。

## 降级矩阵（宿主能力 × 三态决策）

ask（人工审批）不是每家宿主都支持，无 ask 能力的点位按家降级
（实现与理由见 `core/capabilities.ts` 顶部注释）：

| 宿主 / 事件 | ALLOW | REVIEW | DENY |
|---|---|---|---|
| Claude Code `PreToolUse` | `permissionDecision: allow` | `ask`（原生） | `deny` |
| Codex `PreToolUse` | `allow` | `allow` + `systemMessage` 警告（降级放行） | `deny` |
| Gemini CLI `BeforeTool` | `decision: allow` | `allow` + `systemMessage` 警告（降级放行） | `decision: deny` |
| Cursor `beforeShellExecution` | `permission: allow` | `ask`（原生） | `deny` |
| Cursor `beforeMCPExecution` | `permission: allow` | `ask`（原生） | `deny` |
| Cursor `preToolUse` | `permission: allow` | `allow` + `user_message` 警告（降级放行） | `deny` |
| OpenCode `tool.execute.before` | 放行 | **throw 阻断**（降级，fail-closed） | throw 阻断 |
| OpenCode `permission.ask` | `status: allow` | `status: ask`（原生） | `status: deny` |
| Copilot CLI `PreToolUse` | `permissionDecision: allow`（顶层+信封双写） | `ask`（原生） | `deny` |
| pi `tool_call`（有 UI） | 放行 | `ctx.ui.confirm` 弹审批（拒绝即 block） | `{block, reason}` |
| pi `tool_call`（无 UI） | 放行 | **block**（降级，fail-closed） | `{block, reason}` |
| ACP `terminal/create` / `fs/write_text_file` | 转发客户端 | `session/request_permission` 向客户端要批准（拒绝回 error -32000） | error -32000 |
| Grok CLI `PreToolUse` | `decision: approve` | **block**（降级，fail-closed；exit 2 + stderr） | block（exit 2 + stderr） |

## 不变量落实

- **fail-closed**：payload 非法 / 方言不可识别 / 归一化失败 / 引擎装配失败
  一律回宿主形状的 DENY（`core/hook.ts`；ACP 回 JSON-RPC error -32000，
  pi/opencode throw 或 block，grok-cli exit 2）。
- **直通例外**：非执行前事件（PostToolUse / AfterTool / SessionStart 等）
  不送判定，直接放行 —— 网关只把守执行前点位。ACP 代理同样只拦
  `terminal/create` / `fs/write_text_file`，其余消息双向直通。
- **审计**：每次判定（含 ALLOW）经引擎写入 `<cwd>/.agentfence/audit.jsonl`。
- **agent_message ≠ 用户发言**：Cursor preToolUse 的 agent_message 不进
  `session.user_intent`（不变量 4 精神）。
- **覆盖边界**：Grok CLI 当前版本的 hook 只接 `bash` 工具；ACP 代理只看
  得到流经客户端的调用（agent 内部工具不过代理）。详见各家 README。
