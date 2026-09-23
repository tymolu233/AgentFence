# OpenCode 适配器

进程内插件（非 stdin/stdout hook），挂两个钩子：

| 钩子 | ALLOW | REVIEW | DENY |
|------|-------|--------|------|
| `tool.execute.before` | 放行 | **throw 阻断**（无 ask 能力，fail-closed 降级） | throw 阻断 |
| `permission.ask` | `status: "allow"` | `status: "ask"`（原生审批） | `status: "deny"` |

`tool.execute.before` 里 REVIEW 与 DENY 都 throw，但错误消息区分
（`AgentFence REVIEW 降级阻断：…` / `AgentFence DENY：…`），agent 会把
消息转告用户。OpenCode 对危险工具自带权限提示，原生 ask 由
`permission.ask` 钩子承接。

## 安装

```bash
npm run build && npx tsc -p integrations/tsconfig.build.json
```

在项目 `.opencode/plugin/agentfence.js` 中桥接（OpenCode 插件目录）：

```js
export { default } from "/path/to/AgentFence/dist/integrations/opencode/plugin.js";
```

配置与审计语义同 `integrations/claude-code/README.md`（插件进程长驻，
审计由后台队列 drain，`best_effort` 模式下进程退出可能丢尾部记录）。
