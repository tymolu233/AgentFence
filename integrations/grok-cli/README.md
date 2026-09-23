# Grok CLI 调研 + 适配器

## 调研结论（2026-09-23）

**有挂接点，已实现适配器**（`hook.ts` / `index.ts`）。但调研对象需要澄清：

- 任务指定的 `github.com/xai-org/grok-cli` **已 404**（GitHub API 确认）。
  xAI 官方 org 现在的 coding agent 是 Rust 重写的
  [`xai-org/grok-build`](https://github.com/xai-org/grok-build)（2026-09 仍活跃）。
- 原 TS grok-cli 的社区延续是
  [`superagent-ai/grok-cli`](https://github.com/superagent-ai/grok-cli)
  （npm 包 `grok-dev`，v1.1.7，调研基线 commit `fb97af83`，2026-05-15）。
  本适配器针对该延续版实现。

### 工具执行路径与挂接点

`superagent-ai/grok-cli` 有完整的命令 hook 系统（`src/hooks/`，17 个事件，
Claude Code 风格）：

- **触发**：`src/grok/tools.ts:107` —— 工具 `execute` 开头调
  `executePreToolHooks(toolName, toolInput, cwd, sessionId)`；
  `preResult.blocked` 时工具不执行，返回 `[Hook blocked] <stderr>`。
- **传输**：`src/hooks/executor.ts` —— `sh -c <command>` 起子进程，
  hook 输入 JSON 走 stdin，stdout 以 `{` 开头则按 JSON 解析；
  退出码 0 = 放行、**2 = 阻断**、其他 = 非阻断错误（放行 + 记录）。
- **payload**：`{ hook_event_name: "PreToolUse", tool_name, tool_input,
  session_id?, cwd }`（`src/hooks/types.ts:35-39`）—— 与 Claude Code
  完全同形（无特征字段，方言靠安装点位钉死，自动识别不可区分）。
- **输出**：`{ decision?: "approve"|"block", reason?, additionalContext?,
  continue?, stopReason? }`。

### 能力限制（决定降级策略）

1. **只有两档**：`decision` 仅 `approve|block`，**无 ask**。
2. **无警告通道**：`reason` / `additionalContext` 字段会被解析聚合，但
   当前版本没有任何代码消费它们（grep 全仓确认）；阻断原因只有经
   **exit 2 + stderr** 才能送达 agent（`tools.ts:109` 只拼
   `blockingErrors` 的 stderr）。
3. **覆盖面**：当前版本 `executePreToolHooks` **只接在 `bash` 工具上**
   （`write_file` / `edit_file` / `computer_*` 等其余 ~41 个工具不触发
   hook）—— 网关只能把守 shell 调用，这是宿主侧限制。

因此 REVIEW **降级为 block**（fail-closed，与 opencode `tool.execute.before`
同族）：静默放行没有任何用户可见性，不如有声阻断 —— stderr 原因会被拼给
agent 转告用户，消息区分 `AgentFence DENY：` 与 `AgentFence REVIEW 降级阻断：`。

| ALLOW | REVIEW | DENY |
|-------|--------|------|
| `{"decision":"approve"}` exit 0 | **block**（exit 2 + stderr，降级） | block（exit 2 + stderr） |

## 安装

```bash
npm run build && npx tsc -p integrations/tsconfig.build.json
```

`~/.grok/user-settings.json`（hook 只从用户级配置加载，宿主有意排除
项目级 `.grok/settings.json` 防恶意仓库投毒）：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/AgentFence/dist/integrations/grok-cli/index.js",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

（宿主经 `sh -c` 执行 hook 命令，需要 POSIX shell 环境。）

- 配置与审计语义同 `integrations/claude-code/README.md`
  （`AGENTFENCE_CONFIG` → cwd 下 `agentfence.yaml` → 仓库内置默认；
  审计落 `<cwd>/.agentfence/audit.jsonl`）。
- 故障语义：payload 非法 / 归一化失败 / 网关初始化失败一律 fail-closed
  `block` + exit 2；PostToolUse 等非执行前事件直通 approve。

## 替代挂接方式（备注）

- 仍在使用已下架的 `xai-org` 原版（无 `src/hooks/` 的 0.x 构建）时无
  hook 可挂：可用 `agentfence exec -- grok -p "..."` 包 headless 调用
  （exec 只能审"启动 agent"这一外壳，粒度粗），或在 MCP 层拦截 ——
  grok-cli 支持 MCP server（`.grok/settings.json` 的 `mcpServers`），
  把 MCP 工具调用代理过 AgentFence 判定即可覆盖该部分。
- Rust 版 `grok-build` 自述 "extensible"，插件机制尚未稳定，未评估。
