# pi 适配器

进程内扩展（非 stdin/stdout hook），挂 `tool_call` 事件 ——
[pi](https://github.com/badlogic/pi-mono)（`@earendil-works/pi-coding-agent`）
在执行任何工具前触发，扩展返回 `{ block: true, reason }` 即阻断。

| ALLOW | REVIEW | DENY |
|-------|--------|------|
| 返回 `undefined` 放行 | 有 UI：`ctx.ui.confirm` 弹人工审批（拒绝即 block）；**无 UI：直接 block**（fail-closed 降级） | `{ block: true, reason }` |

`ctx.hasUI` 为 false（headless / `--print` 等场景）时没有可交互的审批通道，
REVIEW 无法落地为 ask，按 fail-closed 降级为 block —— 与上游 jev-guard
的 pi 扩展行为一致（`extensions/jev-guard.ts:24-27`）。

## 安装

```bash
npm run build && npx tsc -p integrations/tsconfig.build.json
```

`~/.pi/agent/settings.json` 的 `extensions` 数组加入产物路径：

```json
{
  "extensions": ["/path/to/AgentFence/dist/integrations/pi/extension.js"]
}
```

或一次性加载：`pi -e /path/to/AgentFence/dist/integrations/pi/extension.js`。

- 配置：扩展进程读 `AGENTFENCE_CONFIG` 指向的 `agentfence.yaml`；缺省读 cwd
  下的 `agentfence.yaml`，再没有则用仓库内置 `rules/` + `policies/default.yaml`。
- 审计：`<cwd>/.agentfence/audit.jsonl`（全量，含 ALLOW；进程长驻，后台队列
  drain，`best_effort` 模式下进程退出可能丢尾部记录）。
- 故障语义：事件形状非法 / 引擎装配或判定失败一律 fail-closed `block`。
- 范围：只把守执行前 `tool_call`；`tool_result` 内容扫描不在 AgentFence
  v0.1 范围（网关只判执行前点位）。
