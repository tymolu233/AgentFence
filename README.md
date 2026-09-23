# AgentFence

**Security Gateway for AI Agent Tool Calls**

在 AI Agent 调用 Shell、文件系统、数据库、HTTP 等工具**之前**做执行安全检查，防御模型幻觉、Prompt Injection、恶意 Skill、Tool Poisoning 与误操作导致的危险行为。

AgentFence 不判断"Agent 想完成什么"，只判断：**这个 Tool Call 是否允许真正执行？**

[![ci](https://github.com/tymolu233/AgentFence/actions/workflows/ci.yml/badge.svg)](https://github.com/tymolu233/AgentFence/actions/workflows/ci.yml)

## 特性

- **三态决策**：ALLOW / REVIEW / DENY，附 risk 与 confidence；无法判断时 fail-closed
- **七层管线**：Tool/Skill ACL → Command Parser（AST 级）→ Hard Rules → Policy Engine → AI Risk Judge → Approval → Audit，便宜的确定性检查在前，任一前置层出结论即短路
- **AST 级命令解析**：不做裸字符串匹配——引号拼接、参数换序、等效标志、子命令组合都绕不过
- **规则即数据**：YAML 规则文件按类目组织，每条规则自带测试样例进 CI，支持社区贡献
- **全量审计**：ALLOW 与 DENY 都记录，JSONL + 哈希链防篡改，只存参数摘要不落原文
- **主流 Agent 开箱接入**：Claude Code / OpenCode / Codex CLI / Gemini CLI / Cursor

## 快速开始

```bash
git clone https://github.com/tymolu233/AgentFence.git
cd AgentFence
npm ci && npm run build

# 检查一条命令
node dist/src/cli/index.js check --tool shell --command "rm -rf /"
# → DENY (exit 1)，命中规则 fs.rm-recursive-guarded-path

node dist/src/cli/index.js check --tool shell --command "ls"
# → ALLOW (exit 0)

# 作为执行 wrapper：DENY/REVIEW 不会执行
node dist/src/cli/index.js exec -- <command>
```

退出码约定：`0` ALLOW / `1` DENY / `2` REVIEW。

## 接入你的 Agent

| Agent | 形态 | 说明 |
|---|---|---|
| Claude Code | PreToolUse hook | [integrations/claude-code](integrations/claude-code/README.md) |
| OpenCode | 进程内插件 | [integrations/opencode](integrations/opencode/README.md) |
| Codex CLI | hook（REVIEW 降级为警告放行） | [integrations/codex](integrations/codex/README.md) |
| Gemini CLI | hook（REVIEW 降级为警告放行） | [integrations/gemini-cli](integrations/gemini-cli/README.md) |
| Cursor | beforeShellExecution / beforeMCPExecution / preToolUse | [integrations/cursor](integrations/cursor/README.md) |
| Copilot CLI | PreToolUse hook（原生 ask） | [integrations/copilot](integrations/copilot/README.md) |
| pi | 进程内扩展（无 UI 时 REVIEW 降级 block） | [integrations/pi](integrations/pi/README.md) |
| ACP 宿主（Zed 等） | JSON-RPC stdio 代理（原生 ask） | [integrations/acp](integrations/acp/README.md) |
| Grok CLI（社区延续版） | PreToolUse hook（REVIEW 降级 block） | [integrations/grok-cli](integrations/grok-cli/README.md) |

任意其他框架可直接调判定 API（见 `src/api/types.ts` 的 `ToolCall` / `Decision` 契约）。

## 规则

`rules/` 下按类目分文件（shell / filesystem / database / cloud / kubernetes / git / iac），首批 40 条规则提炼自真实事故（terraform destroy 连快照删库、Prisma shadow-database 清生产库……）。规则示例：

```yaml
- id: fs.rm-recursive-guarded-path
  category: filesystem
  severity: critical
  action: DENY
  priority: 10
  match:
    tool: shell
    argv0: [rm]
    flags: { recursive: true }
    target_guarded: true
  tests:
    deny: ["rm -rf /", "rm -rf ~"]
    allow: ["rm -rf ./node_modules"]
```

## 配置

单文件 `agentfence.yaml`（`--config` 指定），控制规则目录、环境策略（sandbox / production）、审计目标、judge 开关等；默认 fail-closed。示例见 `policies/default.yaml` 与 `src/cli/config.ts`。

## 文档

- 架构与检查管线：`docs/architecture.md`
- 决策记录（为什么这么设计）：`.agents/notes/`
- 参考项目调研：`docs/research/`
- 参与贡献：`CONTRIBUTING.md`

## License

待定（待定前保留所有权利）。
