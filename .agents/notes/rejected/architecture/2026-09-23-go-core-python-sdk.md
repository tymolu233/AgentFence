# Agent Note: Go 核心 + Python SDK 的技术选型

Status: rejected — 新增硬约束"不限定语言、尽可能适配主流 Agent"，选型标准改变，按 agent 生态重选

## Problem

AgentFence 处于每个 Tool Call 的热路径上，延迟直接加到 Agent 每次行动之前；同时要以 CLI、HTTP API、库三种形态分发，并被 Python 系的 Agent 框架消费。选型决定部署形态与接入成本。

## Proposal

（冻结保留原案）核心引擎（parser / rules / policy / judge 编排 / audit）用 Go：`cmd/agentfence` 出 CLI，HTTP API 与 Go SDK 同源。第一阶段同时提供 Python SDK（薄客户端走 HTTP API 或本地进程）。目录结构：`cmd/ + internal/ + pkg/ + rules/ + policies/ + integrations/`。

## Alternatives considered

- **全 Python** — Agent 生态接入成本最低，但热路径性能、单二进制分发、并发模型都弱；作为 SDK 而非核心。
- **Rust** — 性能与安全最好，但规则/策略层的迭代速度与团队熟悉度不如 Go，生态集成（OPA、K8s）以 Go 为主。

## Risks

否决原因：项目新增硬约束——尽可能适配市面主流 Agent（OpenCode / Claude Code / Codex CLI / Gemini CLI / Cursor / MCP）。这些生态以 TypeScript/Node 为一等分发形态（pre-tool-use hook、插件、MCP SDK）；Go 核心会抬高 hook 形态的分发成本，且重点参考项目 jev-guard（JS）、Vigil（TS）的可借鉴度随之下降。

重提条件：若目标场景转向自托管 sidecar/网关分发为主（DeepintShield 式），或 TS 核心出现不可接受的性能/部署问题，可重提 Go 核心。

后继决策：`.agents/notes/proposed/architecture/2026-09-23-language-selection-by-agent-ecosystem.md`。
