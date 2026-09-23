# Agent Note: 定位为执行安全网关，三态决策 fail-closed

Status: proposed

## Problem

AI Agent 调用 Shell、文件系统、数据库、HTTP、MCP Tool 时，模型幻觉、Prompt Injection、恶意 Skill、Tool Poisoning 或误操作可能产生破坏性动作。市面上的 Prompt Guard / 内容审核 / LLM Guardrail 检查的是文本而非执行行为，拦不住"语义无害但动作危险"的 Tool Call（如一句正常的 shell 删除命令）。

## Proposal

AgentFence 定位为 Agent Execution Security Gateway：不判断 Agent 的意图，只判断 Tool Call 是否允许执行。决策为三态 ALLOW / REVIEW / DENY 并附 risk 与 confidence；无法判断时 FAIL CLOSED。检查管线按成本升序：Tool/Skill ACL → Command Parser（AST 级解析，先解析再匹配防绕过）→ Hard Rules → Policy Engine（OPA/Rego）→ AI Risk Judge → Approval → Audit；ALLOW 后由 Sandbox 兜底。AI Judge 只输出风险评估，不直接控制执行，最终决策由 Policy 汇总。所有调用（含 ALLOW）写审计日志。分层思路的来源项目与学习计划见 `docs/references.md`。

## Alternatives considered

- **二元 allow/deny** — 简单但无法表达"上下文不明确"的中间态，只能要么误拦正常业务、要么放行风险操作；REVIEW + 人工审批覆盖中间态。
- **让 AI Judge 直接裁决执行** — 把最终执行权交给概率模型，违背 fail-closed 原则；Judge 降级为 Policy 的一个输入信号。
- **做成 Prompt 层护栏** — 与现有 Guardrail 产品同质，且在 Tool 层之前拦截无法覆盖 Skill 内部、注入内容转化出的调用；执行边界才是差异点。

## Consequences

正面：对幻觉、注入、恶意 Skill 三类威胁在 Tool 层统一收口， pentest 等"正常工作需要危险动作"的场景可按环境分级放行。代价：需要维护规则库与解析器，对每种新 Tool 都要接入适配。强制要求：后续任何新 Tool 接入必须先定义 ACL 与规则类目；任何"交给模型判断"的改动不得绕过 Policy 直控执行。
