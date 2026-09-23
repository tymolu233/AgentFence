# 架构地图

AgentFence 是 AI Agent 的执行安全网关（Agent Execution Security Gateway）：不判断"Agent 想完成什么"，只判断"这个 Tool Call 是否允许真正执行"。它位于 Agent 与真实世界之间，是执行安全边界，不是 Prompt Guard / 内容审核 / LLM Guardrail，也不是另一个 LLM。

## 决策模型

每个 Tool Call 得到三态决策，附风险与置信度：

- **ALLOW** — 确定安全（读文件、查状态、普通 HTTP GET、recon）
- **REVIEW** — 上下文不明确（改配置、写文件、访问敏感目录、高权限 Tool、可能影响目标状态）→ 人工审批
- **DENY** — 确定危险（删库、删系统文件、破坏生产资源、凭证外传、未授权网络访问、反向 Shell）

核心原则：确定危险直接 DENY；确定安全 ALLOW；上下文复杂交 AI Judge；高风险 REVIEW；无法判断 **FAIL CLOSED**。

决策响应结构：

```json
{
  "decision": "ALLOW",
  "risk": "LOW",
  "confidence": 0.98,
  "reason": "Read-only reconnaissance command"
}
```

## 检查管线

Tool Call 依次穿过七层检查：便宜的确定性检查在前、贵的在后，任一前置层给出确定结论即短路。设计取舍见 `.agents/notes/proposed/architecture/`，分层思路的来源项目见 `docs/references.md`。

1. **Tool / Skill ACL** — 按 Agent 收口可调用工具集与权限（如 research agent `shell.allowed: false` → 直接 DENY）。只看 tool 名与 manifest，不解析输入，成本最低，放最前。Skill 带 Manifest 声明权限，Skill 内部越权调用同样被 ACL 拦截。
2. **Command Parser** — Raw input 经 Shell Parser 解析为 AST（executable / args / pipe / redirect / environment），输出结构化风险画像：`filesystem.{read,write,delete}`、`network`、`privilege`。必须先解析再匹配，否则规则被字符串混淆绕过；禁止裸字符串匹配。
3. **Hard Rules** — 在解析结果上跑确定性规则（危险命令 / 路径 / 参数 / API / Tool），不调 LLM。规则不写死，按类目存于 `rules/*.yaml`（filesystem、database、network、credentials、shell、cloud、kubernetes、git、pentest），支持社区贡献。规则形如 `id / category / severity / match / action`。
4. **Policy Engine** — OPA/Rego；Agent × Target × Tool × Action × Environment × Risk 联合判定。同一动作在 sandbox 与 production 下结论不同。
5. **AI Risk Judge (Jev)** — 只判断复杂上下文中的风险，输出 risk / decision / confidence / reason；**不直接控制执行**，其输出回到 Policy 汇总出最终决策。
6. **Approval Engine** — REVIEW 的人工审批通道。
7. **Audit** — 全量记录，见"审计"一节。

ALLOW 之后由 **Sandbox** 兜底：即使前五层判错，Docker / VM / namespace / 只读 FS / 资源限额 / 网络 ACL 仍限制实际破坏范围。

## 关键数据结构

统一 Tool Call：

```json
{
  "request_id": "req_xxx",
  "agent_id": "pentest-agent",
  "session_id": "session_xxx",
  "tool": { "name": "shell", "action": "execute" },
  "input": { "command": "..." },
  "context": { "target": "lab", "environment": "sandbox" }
}
```

## 接口

- **Decision API**：`POST /v1/check`（agent / tool / action / input / context → decision / risk / confidence / matched_rules / reason）
- **SDK**：Go 核心，Python SDK 第一阶段提供
- **CLI**：`agentfence check --tool shell --command "..."`；wrapper 模式 `agentfence exec -- <command>`
- **配置**：单文件（`mode: fail_closed`、rules 开关、按环境的 policy、judge / approval / sandbox 开关）

## 审计

所有 Tool Call 都记录：timestamp / agent / tool / risk / decision / matched rules / judge 使用情况。**DENY 和 ALLOW 都必须记录**，否则无法分析 Agent 行为。

## 目录结构

```
cmd/agentfence/        # CLI 入口
internal/              # engine / parser / rules / policy / judge / approval / audit / sandbox
pkg/                   # api / sdk
rules/                 # shell / filesystem / database / network / pentest
policies/
integrations/          # opencode / mcp / claude / generic
examples/  tests/  docs/
```

## 演进路线

- v0.1 四个模块最小闭环：`internal/rules`（Vigil 思路）、`internal/policy`（DeepintShield 思路）、`internal/judge`（jev-guard 思路，接口先行、默认关闭）、`internal/engine` gateway 编排（Guardian/AgentGuard 思路）；首个接入 OpenCode，产出 ALLOW / REVIEW / DENY。审计自 v0.1 起全量记录。不做 Dashboard、Cloud、大量框架适配、ML/自训模型。
- v0.2 MCP Gateway 接入
- v0.3 Pentest Policy 与 Target Authorization
- v0.4 Docker Sandbox 与网络隔离
- v0.5 Skill Scanner、审计增强（防篡改链）

> Pentest 是目标场景但不做一刀切拦截：Recon / Scanner 允许，Exploit 走 Sandbox/Review，Credential Access 走 Review，Destructive 拒绝。分层理由见 `.agents/notes/proposed/architecture/`。
