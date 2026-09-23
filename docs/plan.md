# 任务计划

目标：按 `docs/references.md` 的路线，第一周完成调研，随后交付 v0.1 最小闭环（`OpenCode → AgentFence → ALLOW/REVIEW/DENY`）。

## Phase A — 调研（第 1 周，时间盒）

固定产出格式：每个项目一份报告进 `docs/research/`，含三节——**Tool Call 数据结构**、**决策流程（Hook/Gateway 边界）**、**可借鉴点 / 不可照抄点**；引用须带 `file:line`。调研报告不是决策笔记；调研催生的拍板才进 `.agents/notes/`。

| ID | 任务 | 时间盒 | 产出 | 状态 |
|---|---|---|---|---|
| A1 | 深读 [leepokai/jev-guard](https://github.com/leepokai/jev-guard)（`src/ hooks/ extensions/`）；**额外关注它如何同时适配 8 个 agent（hook 形态与分发方式）** | 1–2 天 | `docs/research/jev-guard.md` | 进行中（agent） |
| A2 | 深读 [hexitlabs/vigil](https://github.com/hexitlabs/vigil)（`checkAction` 与规则表） | 1–2 天 | `docs/research/vigil.md` | 进行中（agent） |
| A3 | 深读 [Deepint-Shield/ai-security](https://github.com/Deepint-Shield/ai-security)（Gateway/PDP 边界、`/decide`） | 1–2 天 | `docs/research/deepintshield.md` | 进行中（agent） |
| A4 | 速读 [LegionForge/guardian](https://github.com/LegionForge/guardian)（7 个确定性检查、Task token ACL、Tool Registry） | 半天 | `docs/research/guardian.md` | 待办 |
| A5 | 速读 [WhitzardAgent/AgentGuard](https://github.com/WhitzardAgent/AgentGuard)（GPL-3.0，只看思路）+ [hidearmoon/agentguard](https://github.com/hidearmoon/agentguard)；**额外关注各自适配了哪些 agent 框架、如何挂接** | 半天 | `docs/research/agentguard.md` | 待办 |
| A6 | 提取 [roboticforce/agent-guardrails](https://github.com/roboticforce/agent-guardrails) 规则库：DENY/REVIEW 清单与易绕过模式 | 半天 | `docs/research/agent-guardrails.md` + 规则候选清单 | 待办 |
| A7 | 综合拍板：Tool Call 数据结构 v1 + 规则格式 v1 + **核心语言选型**（按 `.agents/notes/proposed/architecture/2026-09-23-language-selection-by-agent-ecosystem.md` 三条标准） | 1 天 | `.agents/notes/` | 待办，依赖 A1–A3 |

## Phase B — v0.1 骨架（第 2 周起，依赖 A7）

| ID | 任务 | 产出 | 状态 |
|---|---|---|---|
| B1 | 核心骨架（语言按 A7）：模块 engine / parser / rules / policy / judge / approval / audit + CLI；CI 自动激活（`ci.yml` 已按 Go/TS/Python 三选一守卫） | 骨架 + build/lint/test 绿 | 待办 |
| B2 | 统一类型：`ToolCall` / `Decision` / `CheckRequest` / `CheckResponse` | 类型 + 序列化测试 | 待办 |
| B3 | 规则引擎 + 首批规则：`rules/{shell,filesystem,network}.yaml` ≥10 条（来源 A6） | 引擎 + YAML + 单测 | 待办 |
| B4 | Shell parser：AST 解析出 executable/args/pipe/redirect/env，禁裸字符串匹配（解析库随 A7 语言定） | parser + 单测 | 待办 |
| B5 | Policy 引擎：接口 + 内置环境策略（sandbox/production）；OPA 接入选配后置 | policy + 单测 | 待办 |
| B6 | Judge 接口 + noop 实现（默认关闭，fail-closed 语义不受其影响） | judge | 待办 |
| B7 | Engine 编排管线（ACL→Parser→Rules→Policy→Judge→Audit）+ CLI `agentfence check` | CLI 可用 | 待办 |
| B8 | 审计：JSONL 全量记录 ALLOW/DENY | 日志落盘 + 单测 | 待办 |
| B9 | OpenCode hook 适配（参考 A1 报告；只改 `integrations/`，不动核心判定） | `integrations/opencode` | 待办 |
| B10 | `docs/testing.md` 测试政策 + `scripts/verify/` 首批机械规则 3–5 条 | 文档 + 脚本进 CI | 待办 |

## Phase C — 适配扩展（v0.2–v0.3，依赖 B9 验证适配器模式）

| ID | 任务 | 产出 | 状态 |
|---|---|---|---|
| C1 | MCP Gateway（Tier 2，一次覆盖所有 MCP host） | `integrations/mcp` | 待办 |
| C2 | Claude Code PreToolUse hook 适配 | `integrations/claude-code` | 待办 |
| C3 | Codex CLI / Gemini CLI / Cursor 适配 | `integrations/{codex,gemini-cli,cursor}` | 待办 |
| C4 | Generic SDK 接入示例（LangChain 等任意框架，Tier 3） | `examples/` | 待办 |

## v0.1 验收

1. `agentfence check --tool shell --command "rm -rf /"` → DENY，`agentfence check --tool shell --command "ls"` → ALLOW；
2. 每次判定（含 ALLOW）写入审计日志；
3. 项目 build / lint / typecheck / test 与 `scripts/check` 全绿。

## 分工原则

- 调研报告、规则提取、骨架与独立模块 → 可派 agent 并行（任务边界以文件路径隔离，agent 不提交 git）。
- 决策拍板（A7，含语言选型）、规则条目终审、对外接口定稿 → 人来定，agent 只出草案。
