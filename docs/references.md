# 参考项目学习路线

AgentFence 不重复造轮子：六个项目各学一样东西，组合成面向 Agent Tool Execution 的安全边界。原则：**每个项目只学一个东西，不照抄其产品定位与代码**（注意 license，见文末）。

| 顺序 | 项目 | 仓库 | 语言 | 学什么 |
|---|---|---|---|---|
| 1 | jev-guard | [leepokai/jev-guard](https://github.com/leepokai/jev-guard) | JS | Jev + Hook + Context |
| 2 | Vigil | [hexitlabs/vigil](https://github.com/hexitlabs/vigil) | TS | Rule Engine |
| 3 | DeepintShield | [Deepint-Shield/ai-security](https://github.com/Deepint-Shield/ai-security) | Go | Gateway + Policy |
| 4 | Guardian | [LegionForge/guardian](https://github.com/LegionForge/guardian) | Python | Deterministic Security |
| 5 | AgentGuard | [WhitzardAgent/AgentGuard](https://github.com/WhitzardAgent/AgentGuard)、[hidearmoon/agentguard](https://github.com/hidearmoon/agentguard) | Python | Runtime Security |
| 6 | agent-guardrails | [roboticforce/agent-guardrails](https://github.com/roboticforce/agent-guardrails) | Shell | 危险操作规则库 |

## 1. jev-guard — Jev Adapter + Agent Hook 参考实现

基于 Jev 的 Coding Agent Security Hook：对 Tool Call 结合 session context 做风险评分（源码中阈值 `deny ≥ 2.5; ask ≥ 1.5; else allow`），覆盖 Skill/Plugin/Tool Result 中的 Prompt Injection，适配 Claude Code / Codex / OpenCode 等。重点读 `src/`、`hooks/`、`extensions/`，搞清楚 `Agent → Hook → Tool Call → Jev → Decision` 的通路。

## 2. Vigil — Rule Engine 参考实现

"Validates what agents **do**, not what they say"：执行前 pattern-based 检查，<2ms、零依赖；核心 API `checkAction(input)` → ALLOW / BLOCK / ESCALATE。规则覆盖 destructive command、SSRF、exfiltration、SQL injection、path traversal、prompt injection、encoding attack、credential leak。注意：同名的 `deadbits/vigil-llm` 是 Prompt 文本扫描器，**不是**本项目参考对象。学习后升级为 `Rule → Parser → Policy → Jev → Final Decision`。

## 3. DeepintShield — Gateway + Policy 架构参考

自托管 AI 安全网关（Go 核心）：Guardrails、Agentic Policy Decision Point（`/decide` 端点）、ABAC/Rego + 决策缓存、Tool/Agent Action 授权、MCP Gateway、OpenTelemetry observability。重点学 `Agent → Gateway → Policy Decision Point → Tool` 的边界划分，而不是把安全逻辑塞进 Judge。

## 4. Guardian — Deterministic Security 参考

"Deterministic security sidecar"：FastAPI sidecar，Tool 执行前跑 7 个确定性检查，明确不依赖 LLM（"No LLM. No heuristics."），含 Task token ACL 与 Tool Registry。核心启示：**安全边界不依赖另一个模型**。

## 5. AgentGuard（两个方向）— Runtime Security 参考

- **WhitzardAgent/AgentGuard**：Zero-Trust Security Foundation，Pre-LLM / Post-LLM / Pre-Tool / Post-Tool / Audit 五段介入，模块化策略。（GPL-3.0，只看思路。）
- **hidearmoon/agentguard**：runtime security layer，trust 评估、3 层 intent consistency、permission 强制、Merkle 防篡改 audit 链，毫秒级延迟，drop-in 支持 LangChain/CrewAI/AutoGen/MCP。

## 6. agent-guardrails — 规则数据集参考

不读架构，只当 Rule Dataset：Database / Terraform / Kubernetes / Cloud / Git / Prisma 的 destructive operation hard-block 规则与 hooks。研究"什么该 DENY、什么该 REVIEW、哪些命令容易被绕过"，然后**重新设计自己的规则格式**。

## 组合方式

```
              Agent
                │
                ▼
         ┌──────────────┐
         │ AgentFence   │
         ├──────────────┤
         │ Deterministic│ ← Guardian 思路
         │ Rules        │ ← Vigil 思路
         │ Policy       │ ← DeepintShield 思路
         │ Jev          │ ← jev-guard 思路
         └──────┬───────┘
                ▼
              Tool
```

差异化落在现有项目都没覆盖的组合上：Pentest Policy、OpenCode 集成、MCP 集成、Skill Security、Target Authorization。

## 执行约束

- **时间盒**：前三个项目每个 1–2 天，后三个每个半天 skim；超时就停，回头写代码时按需补读。
- **固定产出**：每个项目读完留一份报告进 `docs/research/`——Tool Call 数据结构、决策流程、Hook/Gateway 边界三节；调研催生的决策另写 `.agents/notes/`。任务分解见 `docs/plan.md`。
- **License**：WhitzardAgent/AgentGuard 为 GPL-3.0；其余亦在引用前核对。学规则设计与架构划分，不复制代码。
- 第一周不写业务代码，先把 jev-guard → Vigil → DeepintShield 三个项目看透。
