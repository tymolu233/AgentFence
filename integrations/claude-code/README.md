# Claude Code 适配器

PreToolUse hook：stdin 收 Claude Code 的 PascalCase payload，stdout 回
`hookSpecificOutput.permissionDecision`（allow / ask / deny）。三档齐全，无降级。

## 安装

```bash
npm run build && npx tsc -p integrations/tsconfig.build.json
```

`~/.claude/settings.json`（或项目 `.claude/settings.json`）注册 hook：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/AgentFence/dist/integrations/claude-code/index.js"
          }
        ]
      }
    ]
  }
}
```

- 配置：hook 进程读 `AGENTFENCE_CONFIG` 指向的 `agentfence.yaml`；缺省读 cwd
  （宿主设为项目根）下的 `agentfence.yaml`，再没有则用仓库内置 `rules/` +
  `policies/default.yaml`。
- 审计：`<cwd>/.agentfence/audit.jsonl`（全量，含 ALLOW）。
- 故障语义：payload 非法 / 网关初始化失败一律 fail-closed 回 `deny`。
