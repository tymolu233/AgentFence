# 架构地图

AgentFence 是 AI Agent 的执行安全网关（Agent Execution Security Gateway）：不判断"Agent 想完成什么"，只判断"这个 Tool Call 是否允许真正执行"。它位于 Agent 与真实世界之间，是执行安全边界，不是 Prompt Guard / 内容审核 / LLM Guardrail，也不是另一个 LLM。

核心语言为 **TypeScript**（Node ≥22，strict）；HTTP Decision API 是跨语言契约。见 `.agents/notes/implemented/architecture/2026-09-23-language-selection-by-agent-ecosystem.md`。

## 决策模型

每个 Tool Call 得到三态决策，附风险与置信度：

- **ALLOW** — 确定安全（读文件、查状态、普通 HTTP GET、recon）
- **REVIEW** — 上下文不明确（改配置、写文件、访问敏感目录、高权限 Tool、可能影响目标状态）→ 人工审批
- **DENY** — 确定危险（删库、删系统文件、破坏生产资源、凭证外传、未授权网络访问、反向 Shell）

核心原则：确定危险直接 DENY；确定安全 ALLOW；上下文复杂交 AI Judge；高风险 REVIEW；无法判断 **FAIL CLOSED**。

决策响应结构见 `src/api/types.ts`（权威定义）；字段语义与六条不变量见 `.agents/notes/implemented/architecture/2026-09-23-tool-call-decision-model.md`。

## 检查管线

Tool Call 依次穿过七层检查：便宜的确定性检查在前、贵的在后，任一前置层给出确定结论即短路。设计取舍见 `.agents/notes/`，分层思路的来源项目见 `docs/references.md`。

1. **Tool / Skill ACL** — 按 Agent 收口可调用工具集与权限（如 research agent `shell.allowed: false` → 直接 DENY）。只看 tool 名与 manifest，不解析输入，成本最低，放最前。Skill 带 Manifest 声明权限，Skill 内部越权调用同样被 ACL 拦截。
2. **Command Parser** — Raw input 经 Shell Parser 解析为 AST（executable / args / pipe / redirect / environment），输出结构化风险画像：`filesystem.{read,write,delete}`、`network`、`privilege`。必须先解析再匹配，否则规则被字符串混淆绕过；禁止裸字符串匹配。及格线见规则格式笔记。
3. **Hard Rules** — 在解析结果上跑确定性规则（危险命令 / 路径 / 参数 / API / Tool），不调 LLM。规则是 YAML 数据，按类目存于 `rules/*.yaml`，支持社区贡献；格式与匹配语义见 `.agents/notes/implemented/architecture/2026-09-23-rule-format-v1.md`。
4. **Policy Engine** — Agent × Target × Tool × Action × Environment × Risk 联合判定（OPA/Rego 兜底后置）。同一动作在 sandbox 与 production 下结论不同。
5. **AI Risk Judge (Jev)** — 只回答类型化窄问题，**不直接控制执行**；只在规则与策略未出结论的灰区触发，阈值表见 `.agents/notes/implemented/architecture/2026-09-23-judge-thresholds.md`。
6. **Approval Engine** — REVIEW 的人工审批通道。
7. **Audit** — 全量记录，见"审计"一节。

ALLOW 之后由 **Sandbox** 兜底：即使前五层判错，Docker / VM / namespace / 只读 FS / 资源限额 / 网络 ACL 仍限制实际破坏范围。

## Agent 适配

适配市面主流 Agent 是一等目标，按三层覆盖：

- **Tier 1 · 原生 Hook** — OpenCode（plugin）、Claude Code（PreToolUse hook）、Codex CLI、Gemini CLI、Cursor：逐个实现适配器，挂接各 agent 的 pre-tool-use 点位。
- **Tier 2 · MCP Gateway** — 以 MCP 代理覆盖所有 MCP host，一次适配最大覆盖面。
- **Tier 3 · Generic** — HTTP Decision API + 薄 SDK，任意框架（LangChain / CrewAI / AutoGen 等）自行接入。

适配器只做协议转换：把各 agent 的 tool call 事件映射为统一 `ToolCall`，把 `Decision` 映射回各 agent 的放行/阻断语义；判定逻辑只在核心一份。

## 接口

- **Decision API**：`POST /v1/check`（agent / tool / action / input / context → Decision）
- **SDK**：薄客户端；TypeScript 随核心，Python SDK 在 Phase C 提供
- **CLI**：`agentfence check --tool shell --command "..."`；wrapper 模式 `agentfence exec -- <command>`
- **配置**：单文件（`mode: fail_closed`、rules 开关、按环境的 policy、judge / approval / sandbox 开关）

## 审计

所有 Tool Call 都记录：timestamp / agent / tool / risk / decision / matched rules / decision_layer / judge 使用情况。**DENY 和 ALLOW 都必须记录**，否则无法分析 Agent 行为。审计异步出热路径，背压三档（best_effort / durable / fail_closed）。

## 目录结构

```
src/
  api/                  # 统一类型契约（ToolCall / Decision）+ HTTP Decision API
  engine/               # 管线编排（ACL→Parser→Rules→Policy→Judge→Approval→Audit）
  parser/               # shell 词法解析 → ParsedShell
  rules/                # 规则引擎（loader + matcher）
  policy/  judge/  approval/  audit/  sandbox/
  cli/                  # agentfence check / exec
integrations/           # opencode / claude-code / codex / gemini-cli / cursor / mcp / generic
rules/                  # YAML 规则即数据：shell / filesystem / database / network / pentest
policies/  examples/  tests/  docs/
```

## 演进路线

- v0.1 四个模块最小闭环：rules（Vigil 思路）、policy（DeepintShield 思路）、judge（jev-guard 思路，接口先行、默认关闭）、engine 编排（Guardian/AgentGuard 思路）；首个接入 OpenCode，产出 ALLOW / REVIEW / DENY。审计自 v0.1 起全量记录。不做 Dashboard、Cloud、大量框架适配、ML/自训模型。
- v0.2 MCP Gateway 接入（一次覆盖所有 MCP host）
- v0.3 Pentest Policy 与 Target Authorization；Claude Code / Codex CLI / Gemini CLI / Cursor 适配器
- v0.4 Docker Sandbox 与网络隔离
- v0.5 Skill Scanner、审计增强（防篡改链）

> Pentest 是目标场景但不做一刀切拦截：Recon / Scanner 允许，Exploit 走 Sandbox/Review，Credential Access 走 Review，Destructive 拒绝。分层理由见 `.agents/notes/`。
