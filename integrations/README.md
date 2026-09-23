# AgentFence 适配层（任务 B9）

把五家主流 Coding Agent 的 pre-tool-use hook 接到 AgentFence 引擎上。
适配器只做协议转换：宿主 payload → 统一 `ToolCall` → `engine.check` →
把 `Decision` 回译为宿主响应；判定逻辑只在核心（`docs/architecture.md`
"Agent 适配"）。方言依据：`docs/research/jev-guard.md`。

## 结构

```
core/          共享归一层：payload 守卫 → 方言识别 → 归一化 → 能力矩阵 → 回译
claude-code/   PreToolUse hook（stdin/stdout）
codex/         PreToolUse hook（payload 同 Claude 形，多 turn_id+model）
gemini-cli/    BeforeTool hook（stdin/stdout）
cursor/        beforeShellExecution / beforeMCPExecution / preToolUse 三事件
opencode/      进程内插件（tool.execute.before + permission.ask）
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

## 不变量落实

- **fail-closed**：payload 非法 / 方言不可识别 / 归一化失败 / 引擎装配失败
  一律回宿主形状的 DENY（`core/hook.ts`）。
- **直通例外**：非执行前事件（PostToolUse / AfterTool / SessionStart 等）
  不送判定，直接放行 —— 网关只把守执行前点位。
- **审计**：每次判定（含 ALLOW）经引擎写入 `<cwd>/.agentfence/audit.jsonl`。
- **agent_message ≠ 用户发言**：Cursor preToolUse 的 agent_message 不进
  `session.user_intent`（不变量 4 精神）。
