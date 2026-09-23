# Gemini CLI 适配器

BeforeTool hook：stdin 收 `{ hook_event_name: "BeforeTool", tool_name,
tool_input }`，stdout 回 `{ decision: allow|deny, reason, systemMessage? }`。

**降级**：BeforeTool 没有 ask 决策。REVIEW → `decision: "allow"` +
`systemMessage` 警告（警告放行）；DENY → `deny`；ALLOW → `allow`。
`AfterTool` / `BeforeAgent` 不是执行前点位，直通放行。

## 安装

```bash
npm run build && npx tsc -p integrations/tsconfig.build.json
```

`~/.gemini/settings.json` 注册 BeforeTool hook：

```json
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/AgentFence/dist/integrations/gemini-cli/index.js"
          }
        ]
      }
    ]
  }
}
```

配置与审计语义同 `integrations/claude-code/README.md`。
