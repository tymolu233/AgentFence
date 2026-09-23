# Agent Note: 语言选型跟随 Agent 生态适配性，HTTP API 解耦

Status: implemented

## Problem

项目的硬约束是"尽可能适配市面主流 Agent"。主流 coding agent（OpenCode、Claude Code、Codex CLI、Gemini CLI、Cursor）与 MCP 生态以 TypeScript/Node 为一等分发形态；Agent 框架（LangChain / CrewAI / AutoGen）以 Python 为主；自托管 sidecar/网关场景则偏好单二进制（Go）。核心语言直接决定 hook/插件适配成本、参考项目可借鉴度与部署形态。

## Decision

核心引擎用 **TypeScript**（Node ≥22，strict 模式）：判定层、CLI、hook 适配器一体，npm 分发。两条不变量：

1. 判定逻辑只在核心实现一份，HTTP Decision API（`POST /v1/check`）为跨语言契约，任何 agent 不经 SDK 也可接入；
2. 适配器只做协议转换（各 agent 的 tool call 事件 ↔ 统一 `ToolCall`/`Decision`），判定逻辑不随适配器复制。

Python SDK 在 Phase C 提供（Agent 框架生态）。依据：`docs/research/synthesis.md` 草案三。

## Alternatives considered

- **Go 核心** — 单二进制分发好，但插件/hook 形态分发成本高、最贴近的两个参考实现（jev-guard/Vigil）非 Go；已否决，见 `.agents/notes/rejected/architecture/2026-09-23-go-core-python-sdk.md`（转向 sidecar 主战场时可重提）。
- **Python 核心** — Agent 框架接入最顺，但热路径性能与 Node 系 hook 分发弱于 TS。
- **多语言各写一份引擎** — 判定逻辑漂移，明确禁止。

## Consequences

正面：Tier-1 适配目标全是 Node 生态，npx 零安装摩擦；jev-guard/Vigil 可代码级借鉴。代价与对策：JS 正则有 ReDoS 面——结构化解析先行、规则匹配前长度截断、正则为兜底，必要时引入 RE2 binding。强制要求：HTTP API 契约与语言无关；新增 agent 适配器只能改 `integrations/`。
