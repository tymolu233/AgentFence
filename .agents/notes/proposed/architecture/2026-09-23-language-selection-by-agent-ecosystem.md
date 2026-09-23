# Agent Note: 语言选型跟随 Agent 生态适配性，HTTP API 解耦

Status: proposed

## Problem

项目的硬约束是"尽可能适配市面主流 Agent"。主流 coding agent（OpenCode、Claude Code、Codex CLI、Gemini CLI、Cursor）与 MCP 生态以 TypeScript/Node 为一等分发形态；Agent 框架（LangChain / CrewAI / AutoGen）以 Python 为主；自托管 sidecar/网关场景则偏好单二进制（Go）。核心语言直接决定 hook/插件适配成本、参考项目可借鉴度与部署形态，选错语言会让"适配主流 Agent"事倍功半。

## Proposal

不预先锁定语言。两条不变量先固定：

1. 判定逻辑只实现一份，HTTP Decision API（`POST /v1/check`）为跨语言契约，任何 agent 不经 SDK 也可接入；
2. 适配器只做协议转换（各 agent 的 tool call 事件 ↔ 统一 `ToolCall`/`Decision`），判定逻辑不得随适配器复制。

核心语言在 A7 按三条标准拍板：① 主流 agent hook 形态的分发成本；② 重点参考项目（jev-guard / Vigil / DeepintShield）的可借鉴度；③ 部署形态（插件 vs 单二进制 sidecar）。当前倾向 TypeScript 核心 + HTTP API + Python/Go 薄 SDK；若 sidecar 场景成为主战场再评估 Go。

## Alternatives considered

- **Go 核心** — 单二进制分发好，但插件/hook 形态分发成本高；已否决，见 `.agents/notes/rejected/architecture/2026-09-23-go-core-python-sdk.md`。
- **Python 核心** — Agent 框架接入最顺，但热路径性能与 hook 分发（多数 coding agent 是 Node 进程）弱于 TS。
- **多语言各写一份引擎** — 判定逻辑漂移，明确禁止。

## Consequences

正面：适配面最大化；语言之争后置到 A1–A3 调研数据齐备的 A7。代价：A7 拍板前不开工骨架（任务 B1）。强制要求：HTTP API 契约先行且与语言无关；每新增一个 agent 适配器只能改 `integrations/`，不得改核心判定。
