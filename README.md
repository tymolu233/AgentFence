# AgentFence

**Security Gateway for AI Agent Tool Calls** — 在 AI Agent 调用 Shell、文件系统、数据库、HTTP、MCP Tool 之前进行执行安全检查，防御模型幻觉、Prompt Injection、恶意 Skill、Tool Poisoning 与误操作。

AgentFence 不判断"Agent 想完成什么"，只判断：**这个 Tool Call 是否允许真正执行？**

- 三态决策：ALLOW / REVIEW / DENY，附 risk 与 confidence；无法判断时 fail-closed
- 六层管线：Hard Rules → Command Parser（AST 级）→ Tool/Skill ACL → Policy Engine（OPA/Rego）→ AI Risk Judge → Sandbox
- 全量审计：ALLOW 与 DENY 都记录
- 形态：Go 核心 + CLI + HTTP API + Python SDK

详见 `docs/architecture.md`（架构地图，权威）；原始思路稿存档于 `docs/vision.md`。

## 演进路线

| 版本 | 内容 |
|---|---|
| v0.1 | Rule Engine 直通 ALLOW/DENY（Shell / Filesystem / HTTP） |
| v0.2 | Command Parser、Policy、Audit |
| v0.3 | Jev、Risk Score、REVIEW、Human Approval |
| v0.4 | MCP Gateway、OpenCode 集成、Skill Permission |
| v0.5 | Docker Sandbox、网络隔离、Pentest 规则 |

## 开发规范

本仓库按「反屎山工具包」落地开发规范，按级别渐进：

- **L0 最小必做集**：CI 红线（`.github/workflows/ci.yml`）、一页硬规则（`CONTRIBUTING.md`）、PR 门禁（`.github/PULL_REQUEST_TEMPLATE.md`）
- **L1 标准集**：推送前最小检查（`scripts/check`）、Agent Notes 决策笔记（`.agents/notes/`，结构自检 `scripts/check-notes` 已进 CI）、机械规则脚本化指南（`docs/verify-rules.md`）、笔记语义自检（`docs/notes-quality-gate.md`）

落地路线：第一周按 `docs/verify-rules.md` 挑最先犯的 3–5 条规则写成脚本进 `scripts/verify/`；存量代码走 baseline 冻结（新代码达标，欠债进基线封增量）。
