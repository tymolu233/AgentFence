# Vigil 调研报告

- **仓库**: https://github.com/hexitlabs/vigil（npm 包名 `vigil-agent-safety`，v0.1.0）
- **Commit**: `9e24d39ea8cc4f635d29b5e966e30812b72af904`（2026-02-15，shallow clone 头提交）
- **License**: Apache License 2.0（仓库根 `LICENSE` 全文，`package.json` 标注 `"license": "Apache-2.0"`）
- **语言**: TypeScript（Node.js，零运行时依赖；构建 tsup，测试 vitest，bun 可选）
- **代码规模**: `src/` 仅 5 文件约 525 行（rules.ts 227、types.ts 86、policies.ts 86、cli.ts 113、index.ts 13）

定位：在 agent 工具调用**执行前**对 action payload 做纯 pattern-based 判定，目标延迟 <2ms。规则全部硬编码在源码中，另有与判定引擎解耦的 policy 模板（JSON），集成方式有 CLI、Express 中间件、MCP wrapper 等示例。

## Tool Call 数据结构

**输入 `VigilInput`**（`src/types.ts:2-15`）：所有字段均可选——

| 字段 | 类型 | 说明 |
|---|---|---|
| `agent` | string | agent 标识 |
| `tool` | string | 工具名（如 `exec`、`read`、`write`、`http_request`） |
| `params` / `parameters` | `Record<string, unknown> \| string` | 实际的工具参数（互为别名，`src/rules.ts:155`） |
| `role` | string | agent 角色描述 |
| `context` | `string \| string[]` | 近期对话上下文 |

**Action 建模方式（关键点）**：Vigil 不按工具类型做结构化建模。`serializeInput()`（`src/rules.ts:152-169`）把 `JSON.stringify(params)` 和 `context`、`tool`、`agent`、`role` 直接 `join(' ')` 拼成**一个字符串**，后续所有规则都在这单一文本上跑正则。工具语义、参数名、字段边界全部丢弃。

**输出 `VigilResult`**（`src/types.ts:35-48`）：
- `decision: 'ALLOW' | 'BLOCK' | 'ESCALATE'`（`src/types.ts:18`）
- `rule: RuleCategory | null`——8 个固定类别：ssrf、destructive、exfiltration、sql_injection、path_traversal、prompt_injection、encoding_attack、credential_leak（`src/types.ts:24-32`）
- `confidence: number`、`risk_level: 'low'|'medium'|'high'|'critical'`、`reason: string`、`latencyMs: number`

**规则声明 `RuleSet`**（`src/types.ts:62-67`）：`{ patterns: RegExp[]; decision: Decision; risk: RiskLevel; desc: string }`。8 组正则常量定义在 `src/rules.ts:21-137`，汇总表 `RULE_SETS` 在 `src/rules.ts:140-149`：7 类 `BLOCK` + `credential_leak` 为 `ESCALATE`。规则以 TS 常量硬编码，改规则 = 改代码发版，没有外部规则文件 + 热加载机制。

**Policy（声明性，独立于判定）**：`VigilPolicy`（`src/types.ts:70-86`）含 `allowedTools / blockedTools / blockedPatterns / allowedPaths / blockedPaths / maxParams / network`。三个内置模板 inline 在 `src/policies.ts:9-58`（restrictive/moderate/permissive），`loadPolicy()` 支持外部 JSON（`src/policies.ts:64-79`）。**注意：`checkAction()` 完全不消费 policy**——policy 只是给调用者的配置模板，执行靠集成方自己写代码。

## 决策流程

`checkAction(input)` 全链路（`src/rules.ts:177-227`）：

1. `performance.now()` 记开始时间（`src/rules.ts:178`）。
2. `serializeInput()` 拼成单一搜索串（`src/rules.ts:181`）。
3. **双层循环逐类逐 pattern 匹配**（`src/rules.ts:183-184`）：按 `Object.entries(RULE_SETS)` 即声明顺序遍历（ssrf → destructive → exfiltration → sql_injection → path_traversal → prompt_injection → encoding_attack → credential_leak）。
4. **短路点为"首个命中即返回"**（`src/rules.ts:185-202`）：一个 action 命中多个类别时只报声明顺序最靠前的那条；不存在"收集全部命中再仲裁"。ESCALATE 类排在最后，与 BLOCK 同时命中时 BLOCK 胜出——此优先级语义隐式、未文档化。
5. 命中时构造结果（`src/rules.ts:187-195`）：`decision = enforce 模式 ? ruleSet.decision : 'ALLOW'`；`confidence` **硬编码 0.95**；`reason` 截取 pattern source 前 60 字符 + 命中文本前 40 字符。
6. 非 ALLOW 时触发 `onViolation` 回调（`src/rules.ts:197-199`，回调经 `configure()` 全局注册，`src/rules.ts:15-18`）。

**ESCALATE 的语义与去向**：仅 `credential_leak` 一类映射到 ESCALATE（`src/rules.ts:148`）。库本身**没有任何落地处理**——不阻塞、不排队、不存证，只返回值 + 调回调。去向完全推给调用方：示例 mcp-wrapper 只是 `console.warn`（`examples/mcp-wrapper.ts:33-36`），CLI 用 exit code 2（`src/cli.ts:102`）。

**异常与 miss 路径（fail-open）**：
- 任何异常（如循环引用导致 `JSON.stringify` 抛错）→ catch 返回 `ALLOW, confidence 0.5, risk medium`（`src/rules.ts:205-216`）。
- 无命中 → `ALLOW, confidence 0.7`（`src/rules.ts:218-226`）。
- `configure({mode})` 支持 enforce / warn / log（`src/types.ts:51`），非 enforce 模式命中也降级为 ALLOW，但 `rule` 字段保留命中类别。

**延迟保证**：没有任何硬保证机制（无超时控制、无 pattern 数上限、无输入长度截断）。<2ms 纯靠经验量：~90 条简单而正则、单次 `String.match`、零 I/O 零依赖；`latencyMs` 计入结果供观测（`src/rules.ts:187`）。JS 正则含 backtracking 引擎，个别 pattern（如 `src/rules.ts:113` 的 `<!--[\s\S]*...-->`）理论上存在 ReDoS 面，未做防护。

## 可借鉴点 / 不可照抄点

### 可借鉴点（→ AgentFence Go + YAML 规则引擎）

1. **API 形状**：`checkAction(input) → {decision, rule, confidence, risk_level, reason, latencyMs}` 是干净的最小契约。三分 decision 直接映射我们的 ALLOW / REVIEW / DENY；`latencyMs` 内嵌结果利于 SLA 观测；`risk_level` 与 decision 解耦（如 ESCALATE 也可携带 critical 风险值）。
2. **RuleSet 声明结构**：`{patterns[], decision, risk, desc}` 即一条 YAML 规则条目的最小模型；类别枚举（8 类）可作为我们 YAML 规则的 `category` 字段起点。
3. **模式设计**：全局 `configure(mode: enforce|warn|log)` + `onViolation` 回调，对应我们的灰度模式与审计 hook；非 enforce 时"decision 降级为 ALLOW 但 rule 保留命中类别"的思路可借鉴（建议我们显式拆成 `raw_decision` / `effective_decision` 两字段，避免歧义）。
4. **集成形态**：CLI exit code 约定（0/1/2，`src/cli.ts:102`）、MCP wrapper 在 handler 前加判定层（`examples/mcp-wrapper.ts:15-40`）是低成本接入参考。
5. **Go 侧优势点**：Go `regexp` 是 RE2、线性时间，天然免疫 ReDoS，比 Vigil 依赖 JS 引擎更稳。注意 Vigil 有一条 pattern 用了 negative lookahead（`/\.\\.\\(?!\\)/`，`src/rules.ts:95`），RE2 不支持，移植需改写。

### 不可照抄点（必须超越）

1. **无 AST / 无语义解析是核心缺陷**。把 params、context、tool、agent 全部拼成一个字符串跑正则（`src/rules.ts:152-169`），字段边界与工具语义全丢。典型绕过路径：
   - shell 引号/变量展开：`r"m" -rf /`、`CMD='rm -rf /'; $CMD` 绕开 `/rm\s+(-[rfvdi]+\s+)*\//`（`src/rules.ts:38`）；
   - 等效命令不通配：`find / -delete`、`rm -rf .`、`dd of=/dev/sda`（无 `if=`）均逃过 `src/rules.ts:37-64`；
   - SSRF 只列了已知 IP 字面量（`src/rules.ts:21-34`），十进制/八进制 IP 变体、DNS rebinding、`http://user@127.0.0.1` userinfo 混淆全漏（只硬编码了 `2852039166` 这一个十进制，`src/rules.ts:29`）；
   - credential 规则绑定固定 token 格式（`ghp_36chars` 等，`src/rules.ts:130-137`），新格式（如 `github_pat_` 前缀）立即失效。
2. **AgentFence 的超越方向**：shell 命令先 tokenize（处理引号、变量、命令替换）再对 argv 做语义判定；URL 用 `net/url` parse 后判 host（含归一化、userinfo 剥离）；路径 `filepath.Clean` 后判目录前缀。规则匹配应按字段路由（`params.command` 走 command 规则、`params.url` 走 SSRF 规则），并支持复合条件（`tool == 'exec' AND pattern`），而不是全局字符串盲扫。
3. **Fail-open 不可接受**：解析异常 → ALLOW（`src/rules.ts:205-216`）在 enforce 网关上等于"异常即放行"。AgentFence 解析失败应默认 DENY 或 REVIEW。
4. **隐式优先级**：声明顺序即仲裁顺序、ESCALATE 排最后导致 BLOCK 恒先报，语义未文档化。我们应显式 `priority` 字段或按 severity 排序，并明确定义"多规则同时命中"的仲裁（如 deny-overrides）。
5. **confidence 硬编码 0.95**（`src/rules.ts:191`）是无信息字段，我们不要照抄；要么给出基于规则精确度的真值，要么去掉。
6. **policy 半成品**：`VigilPolicy` 声明了 allowlist/blocklist/maxParams/network，但引擎不执行（policies.ts 与 rules.ts 零调用关系）。AgentFence 不要做这种"声明与执行脱钩"的接口；YAML 规则文件必须直接被引擎加载执行，并可热更新。
7. **ESCALATE 无落地**：库内仅 console.warn 级别的示例。我们的 REVIEW 必须接真实审批通道（队列/回调/人工确认 + 审计日志），这是网关职责的一部分。
8. **License 约束**：Apache-2.0，可自由借鉴思想、API 形状甚至规则正则，需保留原始 LICENSE 声明与版权声明，修改文件建议加注 NOTICE（仓库无 NOTICE 文件）。建议我们的规则集自行编写并覆盖更广语义，仅将其分类法与模式做参考，不整表复制。

### 一句话结论

Vigil 的价值是"对 action 做执行前判定 + 极简契约 + 零依赖低延迟"的范式验证；其引擎本质是 8 组静态正则在拼接字符串上的短路扫描，规则可被 shell/URL/编码语义层轻易绕过。AgentFence 应取其 API 形状与分类法，弃其"拼接字符串 + 纯正则 + fail-open"核心，用结构化解析 + 显式优先级 + fail-closed 实现真正的执行安全。
