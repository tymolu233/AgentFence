# ACP 适配器

JSON-RPC stdio 代理：坐在 ACP 客户端（Zed / JetBrains / …）与 ACP agent
子进程之间，NDJSON 逐行双向转发，只把守 agent→client 的两个执行前方法：

| agent→client 请求 | 归一化为 |
|---|---|
| `terminal/create` `{sessionId, command, args?, cwd?}` | `{ tool: "Bash", input: { command, cwd? } }`（command 与 args join） |
| `fs/write_text_file` `{sessionId, path, content}` | `{ tool: "Write", input: { file_path, content } }` |

| ALLOW | REVIEW | DENY |
|-------|--------|------|
| 原样转发客户端 | 代理注入 `session/request_permission` 向客户端要批准；批准 → 转发，拒绝/取消/客户端报错 → 回 `error -32000` | 直接回 `error -32000`（不转发） |

其余消息（`initialize`、`session/new`、`session/prompt`、`session/update`、
`fs/read_text_file` 及全部响应）直通不判定 —— 网关只把守执行前点位。
归一化失败 / 引擎异常一律 fail-closed 回 `-32000`。代理自注请求用字符串
id（`agentfence:N`），与 agent 的数字 id 不冲突。

## 安装

```bash
npm run build && npx tsc -p integrations/tsconfig.build.json
```

Zed `settings.json` 的 `agent_servers` 把代理包在真实 agent 外面：

```json
{
  "agent_servers": {
    "Gemini (AgentFence)": {
      "command": "node",
      "args": [
        "/path/to/AgentFence/dist/integrations/acp/index.js",
        "--",
        "gemini",
        "--experimental-acp"
      ]
    }
  }
}
```

- 配置：代理进程读 `AGENTFENCE_CONFIG` 指向的 `agentfence.yaml`；缺省读 cwd
  下的 `agentfence.yaml`，再没有则用仓库内置 `rules/` + `policies/default.yaml`。
- 审计：`<cwd>/.agentfence/audit.jsonl`（全量，含 ALLOW；进程长驻，后台队列
  drain，`best_effort` 模式下进程退出可能丢尾部记录）。
- 覆盖边界：代理只看得到流经客户端的调用。agent 自己内部执行的工具
  （如内置 web fetch）不过代理、不受把守 —— 这类工具要靠 agent 自身的
  hook（若该 agent 同时是 Gemini CLI，可叠加 `integrations/gemini-cli/`）。
- 时序：方向内顺序处理（异步判定不打乱消息顺序）；REVIEW 等待用户审批
  期间该方向后续消息排队（与上游 jev-guard 代理同语义）。
