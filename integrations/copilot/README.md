# Copilot CLI 适配器

PreToolUse hook：stdin 收 Copilot CLI 的 PascalCase payload（与 Claude Code
同形，多一个 ISO `timestamp` 字段），stdout 回 `permissionDecision`
（顶层 + `hookSpecificOutput` 信封双写）。三档齐全（allow / ask / deny），
REVIEW 原生映射 ask，无降级。

> Copilot 云端 agent（coding agent）形态下宿主自身把 ask 当 deny 处理；
> 本地 CLI 的 ask 会正常弹审批。

## 安装

```bash
npm run build && npx tsc -p integrations/tsconfig.build.json
```

`~/.copilot/hooks/agentfence.json`（用户级；每个事件一组 command hook）：

```json
{
  "version": 1,
  "hooks": {
    "PreToolUse": [
      {
        "type": "command",
        "bash": "node /path/to/AgentFence/dist/integrations/copilot/index.js",
        "timeoutSec": 30
      }
    ]
  }
}
```

（Windows 用 `"cmd"` 字段替代 `"bash"`，命令同形。）

- 配置：hook 进程读 `AGENTFENCE_CONFIG` 指向的 `agentfence.yaml`；缺省读 cwd
  下的 `agentfence.yaml`，再没有则用仓库内置 `rules/` + `policies/default.yaml`。
- 审计：`<cwd>/.agentfence/audit.jsonl`（全量，含 ALLOW）。
- 故障语义：payload 非法 / 归一化失败 / 网关初始化失败一律 fail-closed 回
  `deny`；PostToolUse 等非执行前事件直通放行不送判定。
