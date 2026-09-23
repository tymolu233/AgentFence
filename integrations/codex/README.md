# Codex 适配器

PreToolUse hook：payload 与 Claude Code 同形（PascalCase 事件 + `tool_name` /
`tool_input`），多 `turn_id` + `model` 字段。响应回 Claude 风格
`hookSpecificOutput.permissionDecision`。

**降级**：Codex 没有 ask 决策。REVIEW → `allow` + 顶层 `systemMessage`
警告（警告放行）；DENY → `deny`；ALLOW → `allow`。

## 安装

```bash
npm run build && npx tsc -p integrations/tsconfig.build.json
```

Codex hooks 配置（`config.toml` 的 hooks 段）指向：

```
node /path/to/AgentFence/dist/integrations/codex/index.js
```

配置与审计语义同 `integrations/claude-code/README.md`（`AGENTFENCE_CONFIG`
环境变量 / cwd 下 `agentfence.yaml` / 内置默认；审计落 `.agentfence/audit.jsonl`）。
