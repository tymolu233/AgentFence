# Cursor 适配器

三个执行前事件共用一个入口（按 payload 字段自动分发）：

| 事件 | payload | ask 能力 |
|------|---------|----------|
| `beforeShellExecution` | `{ command, cwd }` | 有（REVIEW → `ask`） |
| `beforeMCPExecution` | `{ mcp_server_name, tool_name }` → 合成 `mcp__<server>__<tool>` | 有（REVIEW → `ask`） |
| `preToolUse` | `{ tool_name, tool_input, agent_message }`，`tool_input` 为字符串需二次解析 | **无**（REVIEW → `allow` + `user_message` 警告） |

响应统一为 `{ permission: allow|ask|deny, user_message?, agent_message? }`。

## 安装

```bash
npm run build && npx tsc -p integrations/tsconfig.build.json
```

`~/.cursor/hooks.json`（或项目 `.cursor/hooks.json`）把三个事件指向同一命令：

```json
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [
      { "command": "node /path/to/AgentFence/dist/integrations/cursor/index.js" }
    ],
    "beforeMCPExecution": [
      { "command": "node /path/to/AgentFence/dist/integrations/cursor/index.js" }
    ],
    "preToolUse": [
      { "command": "node /path/to/AgentFence/dist/integrations/cursor/index.js" }
    ]
  }
}
```

配置与审计语义同 `integrations/claude-code/README.md`。
