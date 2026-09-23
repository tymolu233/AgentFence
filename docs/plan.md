# 任务计划

目标：按 `docs/references.md` 的路线，第一周完成调研，随后交付 v0.1 最小闭环（`OpenCode → AgentFence → ALLOW/REVIEW/DENY`）。

## Phase A — 调研（第 1 周，时间盒）

固定产出格式：每个项目一份报告进 `docs/research/`，含三节——**Tool Call 数据结构**、**决策流程（Hook/Gateway 边界）**、**可借鉴点 / 不可照抄点**；引用须带 `file:line`。调研报告不是决策笔记；调研催生的拍板才进 `.agents/notes/`。

| ID | 任务 | 时间盒 | 产出 | 状态 |
|---|---|---|---|---|
| A1 | 深读 [leepokai/jev-guard](https://github.com/leepokai/jev-guard)（`src/ hooks/ extensions/`） | 1–2 天 | `docs/research/jev-guard.md` | 进行中（agent） |
| A2 | 深读 [hexitlabs/vigil](https://github.com/hexitlabs/vigil)（`checkAction` 与规则表） | 1–2 天 | `docs/research/vigil.md` | 进行中（agent） |
| A3 | 深读 [Deepint-Shield/ai-security](https://github.com/Deepint-Shield/ai-security)（Gateway/PDP 边界、`/decide`） | 1–2 天 | `docs/research/deepintshield.md` | 进行中（agent） |
| A4 | 速读 [LegionForge/guardian](https://github.com/LegionForge/guardian)（7 个确定性检查、Task token ACL、Tool Registry） | 半天 | `docs/research/guardian.md` | 待办 |
| A5 | 速读 [WhitzardAgent/AgentGuard](https://github.com/WhitzardAgent/AgentGuard)（GPL-3.0，只看思路）+ [hidearmoon/agentguard](https://github.com/hidearmoon/agentguard) | 半天 | `docs/research/agentguard.md` | 待办 |
| A6 | 提取 [roboticforce/agent-guardrails](https://github.com/roboticforce/agent-guardrails) 规则库：DENY/REVIEW 清单与易绕过模式 | 半天 | `docs/research/agent-guardrails.md` + 规则候选清单 | 待办 |
| A7 | 综合拍板：Tool Call 数据结构 v1 + 规则格式 v1，写成决策笔记，解锁 Phase B | 1 天 | `.agents/notes/` | 待办，依赖 A1–A3 |

## Phase B — v0.1 骨架（第 2 周起，依赖 A7）

| ID | 任务 | 产出 | 状态 |
|---|---|---|---|
| B1 | Go 骨架：`go.mod`、`cmd/agentfence`、`internal/{engine,parser,rules,policy,judge,approval,audit}`、`pkg/api`；CI 自动激活 | 骨架 + `go build ./...` 绿 | 待办 |
| B2 | 统一类型：`ToolCall` / `Decision` / `CheckRequest` / `CheckResponse`（`pkg/api`） | 类型 + 序列化测试 | 待办 |
| B3 | 规则引擎 + 首批规则：`rules/{shell,filesystem,network}.yaml` ≥10 条（来源 A6） | 引擎 + YAML + 单测 | 待办 |
| B4 | Shell parser：AST 解析出 executable/args/pipe/redirect/env，禁裸字符串匹配（候选库 mvdan/sh，A7 定） | `internal/parser` + 单测 | 待办 |
| B5 | Policy 引擎：接口 + 内置环境策略（sandbox/production）；OPA 接入选配后置 | `internal/policy` + 单测 | 待办 |
| B6 | Judge 接口 + noop 实现（默认关闭，fail-closed 语义不受其影响） | `internal/judge` | 待办 |
| B7 | Engine 编排管线（ACL→Parser→Rules→Policy→Judge→Audit）+ CLI `agentfence check` | `agentfence check --tool shell --command ...` 可用 | 待办 |
| B8 | 审计：JSONL 全量记录 ALLOW/DENY（`internal/audit`） | 日志落盘 + 单测 | 待办 |
| B9 | OpenCode hook 适配（参考 A1 报告） | `integrations/opencode` | 待办 |
| B10 | `docs/testing.md` 测试政策 + `scripts/verify/` 首批机械规则 3–5 条 | 文档 + 脚本进 CI | 待办 |

## v0.1 验收

1. `agentfence check --tool shell --command "rm -rf /"` → DENY，`agentfence check --tool shell --command "ls"` → ALLOW；
2. 每次判定（含 ALLOW）写入审计日志；
3. `go build ./... && go vet ./... && go test ./...` 与 `scripts/check` 全绿。

## 分工原则

- 调研报告、规则提取、骨架与独立模块 → 可派 agent 并行（任务边界以文件路径隔离，agent 不提交 git）。
- 决策拍板（A7）、规则条目终审、对外接口定稿 → 人来定，agent 只出草案。
