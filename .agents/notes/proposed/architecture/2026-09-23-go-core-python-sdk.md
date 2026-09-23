# Agent Note: Go 核心 + Python SDK 的技术选型

Status: proposed

## Problem

AgentFence 处于每个 Tool Call 的热路径上，延迟直接加到 Agent 每次行动之前；同时要以 CLI、HTTP API、库三种形态分发，并被 Python 系的 Agent 框架消费。选型决定部署形态与接入成本。

## Proposal

核心引擎（parser / rules / policy / judge 编排 / audit）用 Go：`cmd/agentfence` 出 CLI，HTTP API 与 Go SDK 同源。第一阶段同时提供 Python SDK（`from agentfence import AgentFence`，薄客户端走 HTTP API 或本地进程）。目录结构：`cmd/ + internal/ + pkg/ + rules/ + policies/ + integrations/`。

## Alternatives considered

- **全 Python** — Agent 生态接入成本最低，但热路径性能、单二进制分发、并发模型都弱；作为 SDK 而非核心。
- **Rust** — 性能与安全最好，但规则/策略层的迭代速度与团队熟悉度不如 Go，生态集成（OPA、K8s）以 Go 为主。

## Consequences

正面：单二进制网关可直接做 Sidecar/前置代理，SDK 薄、升级不绑架用户环境。代价：双语言仓库需要两套 CI 与发包流程。强制要求：核心判定逻辑只在 Go 侧实现一份，Python SDK 不内嵌规则引擎，避免两套判定漂移。
