# Grok Build 调研 + 适配器

## 调研结论（2026-09-23）

**有挂接点，已实现适配器**（`hook.ts` / `index.ts`）。调研对象
[`xai-org/grok-build`](https://github.com/xai-org/grok-build) —— xAI 官方
Rust 重写的 coding agent（二进制名 `grok`），调研基线 commit `07e35a3d`
（2026-09-22，monorepo rev `84745de9`）。它取代了已 404 的
`xai-org/grok-cli`；TS 社区延续版 `superagent-ai/grok-cli` 不再适配。

### 工具执行路径与挂接点

grok-build 有完整的 Claude Code 风格 hook 系统（`crates/codegen/xai-grok-hooks/`，
用户文档 `docs/user-guide/10-hooks.md`，15 个事件）：

- **触发**：`xai-grok-shell/src/session/acp_session_impl/tool_calls.rs`
  `apply_pre_tool_use_gate`（:1317）—— 工具分派主路径上每个工具调用
  执行前调 `dispatch_pre_tool_use`；`HookDecision::Deny` 时工具不执行，
  reason 展示给模型。**覆盖面：全部内置工具 + MCP**（MCP 经 `use_tool`
  分发，以限定名 `server__tool` 出现）—— 与 grok-cli 只接 bash 不同。
- **传输**：`xai-grok-hooks/src/runner/command.rs` —— 命令含空格/管道等
  字符时 unix 走 `sh -c`、Windows 走检测到的 shell，否则直接 exec（相对
  路径相对 hook JSON 文件目录）；payload JSON 走 stdin；PreToolUse 默认
  超时 5s（可配 `timeout`）。
- **payload**（`event.rs` `HookEventEnvelope::to_hook_json`，camelCase
  字段 + snake_case 别名双写）：

  ```json
  {
    "hookEventName": "pre_tool_use",
    "hook_event_name": "PreToolUse",
    "sessionId": "abc-123", "session_id": "abc-123",
    "cwd": "/repo", "workspaceRoot": "/repo",
    "permissionMode": "default", "promptId": "turn-1",
    "toolName": "run_terminal_command", "tool_name": "run_terminal_command",
    "toolInput": { "command": "npm test" }, "tool_input": { "...": "..." },
    "toolUseId": "call_1", "toolInputTruncated": false,
    "timestamp": "2026-09-23T12:00:00Z"
  }
  ```

  与 Claude Code 的字段差异：字段名 camelCase（`toolName`/`toolInput`/
  `sessionId`）并附 snake_case 别名；事件名双键双值（camelCase 键
  `hookEventName` 带 snake_case 值，snake_case 键 `hook_event_name` 带
  PascalCase 值）；多 `workspaceRoot` / `permissionMode` / `promptId` /
  `toolUseId` / `toolInputTruncated`。camelCase `hookEventName` 键是
  独有特征，方言自动识别可靠（它同时带 `timestamp`，若无此特征会被
  误判为 copilot）。
- **响应契约**（`runner/mod.rs` `DecisionToken` + `runner/command.rs`
  `parse_blocking_result`）：stdout JSON
  `{ "decision": "allow"|"ask"|"deny"|"defer", "reason"? }`
  （`hookSpecificOutput.permissionDecision` 信封等价且优先；兼容拼写
  `approve`→allow、`block`→deny）。**三档齐全，原生 ask**：ask 把调用
  送进宿主权限提示并展示 reason（always-approve/YOLO 客户端除外）。
  退出码：0 = 按 JSON 决定（无 JSON 则放行）；**2 = 显式阻断**（stdout
  的 allow/ask/defer 在 exit 2 时被压成 deny，stderr 首行兜底为阻断
  原因）；其他非零 = fail-open 记录失败。JSON deny 任意退出码都生效。
- **宿主失败语义：fail-open** —— hook 超时/崩溃/输出非法一律放行（只
  记 scrollback）。因此适配器自身必须保证显式输出：DENY 走 exit 2 +
  stderr + stdout JSON 三写（JSON 损坏时 exit 2 + stderr 仍阻断）。

### 能力结论（决定映射策略）

PreToolUse 契约 allow/ask/deny 三档齐全，**REVIEW 原生映射 ask，无降级**
（与 Claude Code 同档）。DENY 用 exit 2 三写只是利用宿主的阻断通道做
双保险，不是降级。

| ALLOW | REVIEW | DENY |
|-------|--------|------|
| `{"decision":"allow"}` exit 0 | `{"decision":"ask","reason":...}` exit 0（原生） | `{"decision":"deny","reason":...}` exit 2 + stderr |

## 安装

```bash
npm run build && npx tsc -p integrations/tsconfig.build.json
```

`~/.grok/hooks/agentfence.json`（全局 hooks 目录，始终可信，不需要
folder trust；项目级 `.grok/hooks/*.json` 需 `/hooks-trust`）：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/AgentFence/dist/integrations/grok-build/index.js",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

- 不加 `matcher`：网关要对全部工具（含 MCP `server__tool` 限定名）做
  判定，不只 shell。宿主 matcher 里 Claude 别名（Bash/Write/...）会自动
  映射到 grok 原生工具名，与网关的工具归类（`core/tools.ts`）无关。
- 宿主经 shell 执行 hook 命令（命令含空格时 unix `sh -c` / Windows
  检测到的 shell）；`timeout` 默认 5s 偏紧（引擎装配要读规则文件），
  建议显式设 30。
- 配置与审计语义同 `integrations/claude-code/README.md`
  （`AGENTFENCE_CONFIG` → cwd 下 `agentfence.yaml` → 仓库内置默认；
  审计落 `<cwd>/.agentfence/audit.jsonl`）。
- 故障语义：payload 非法 / 归一化失败 / 网关初始化失败一律 fail-closed
  `deny` + exit 2 + stderr；PostToolUse 等非执行前事件直通 allow。
- headless（`grok -p`）同样过 hook（宿主文档：deny rules、hooks、admin
  locks 在所有模式生效）；非交互会话里 ask 无 UI 承接，按宿主权限模式
  处理（auto 分类器 / dontAsk 转 deny），网关侧语义不变。

## 备注

- grok-build 也读 `~/.claude/settings.json` 与 `~/.cursor/hooks.json`
  （兼容层，可在 `~/.grok/config.toml` 的 `[compat.<vendor>] hooks = false`
  关闭）—— 若同时装了 Claude Code 适配器，注意同一条命令可能被两个
  来源的 hook 各评一次（语义一致，只是审计双份）；需要单来源时用
  compat 开关或只在一处配置。
- 宿主另支持 HTTP hook（`"type": "http"`）与插件内 hook；stdio 命令
  hook 是最简形态，本适配器不依赖其余两者。
