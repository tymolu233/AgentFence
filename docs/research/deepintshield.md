# DeepintShield 调研报告（A3）

DeepintShield 是 AgentFence 的 Gateway + Policy 架构参考：自托管 AI 安全网关，核心是把"授权判定"从 LLM/Judge 中抽出来，做成独立的 **PDP（Policy Decision Point）**，Agent/工具的每次动作先过 `Agent → Gateway → PDP → Tool` 这条边界。

## 元信息

- 仓库：https://github.com/Deepint-Shield/ai-security
- Commit：`6ddf96a043fef53ba93dfec0f4242613a8df58a2`（`git clone --depth 1`）
- License：**Apache-2.0**（`LICENSE`），并有 `NOTICE`：代码源自 Maxim HQ 的 Bifrost（Apache-2.0），DeepintShield 在其上叠加安全/治理/agentic 能力。宽松许可，可借鉴模式乃至拷贝代码，但须保留版权与 NOTICE 归属。
- 语言/运行时：Go（`framework/go.mod` 声明 `go 1.26.1`）；关键依赖 `open-policy-agent/opa v1.17.0`、`Yiling-J/theine-go v0.6.2`（`deepintshield_server/framework/go.mod:8,11`）。
- 进程拓扑：**两进程**。`deepintshield_server/`（Go 网关：路由/Provider 适配/MCP/HTTP 传输/agentic PDP/OTel，源自 Bifrost）+ `deepintshield_guard/`（独立 guardrail 运行时：PII/正则/注入扫描，经 gRPC/HTTP `runtimeapi` 被 server 当插件调用，`README.md:459-462`）。**agentic PDP 不在这两进程间走网络**，它是 server 进程内的一个包。

## Tool Call 数据结构

PDP 全部逻辑在 `deepintshield_server/framework/agentic/`（包注释见 `context.go:1-14`：进程内判定、无语义网络跳转、亚毫秒 p99、零数据保留）。

### 请求模型（PDP 输入）

`DelegationContext` 是规范化、provider 无关的判定输入，PDP 永不接触原始 wire token（`context.go:44-72`）：

- 主体：`Principal`、`ActorChain []string`（委托链）、`IdentityType`（user|application）、`Scope []string`。
- 归属：`Tenant`、`Workspace`、`VirtualKey`、`ProviderID`、`SessionID`（不进缓存键）。
- 动作：`Tool`（工具名）、`ArgsDigest`（**参数只存 sha256，不存原始值**——零数据保留的硬约束，`agentic_decide.go:157` 端点强制非空）、`AllowedTools`、`CrossTenant`、`PolicyVersion`。
- ABAC 上下文 `Context`（`context.go:74-107`）：`RAGProvenance`、`CostUsed`、`RecoveryCost`(low|medium|high)、`AgentRiskLevel`、`AgentCapabilities`、`DataClass`（被调工具敏感度，来自 tier 表）、`Namespace`、`HourOfDay`(0-23)、`FingerprintDrift`（供应链 ASI04 信号）、`Integrity`（类型保留、OSS 不填）、`ToolFingerprint`、`DelegationDepth`（服务端由 actor_chain 推出）。`CacheBucket` 仅在策略含 `time_of_day` 时折叠小时桶进缓存键（`json:"-"` 不外发）。

`ComputeArgsDigest`（`context.go:166`）把结构化参数 canonical JSON 后 sha256，是所有调用方构造输入的唯一入口。

### 响应模型（PDP 输出）

`Decision`（`context.go:112-124`）同时携带执行与审计两方面的元数据：

- `Verdict`：封闭集合 `ALLOW / DENY / REQUIRE_APPROVAL / MASK`（`context.go:28-33`）。对 AgentFence 即 ALLOW / REVIEW(≈REQUIRE_APPROVAL) / DENY。
- 执行侧：`Approvers`、`Obligations`（义务，如"必须脱敏/必须二次确认"）。
- 审计侧：`Reason`、`PolicyID`、`DecisionID`、`Mode`、`CacheHit`、`LatencyUS`、`WouldBlock`（shadow 信号）、`Timestamp`。

### ABAC 属性如何建模

规则是**类型化 AST + 闭集判别联合**，而非解释器循环，热路径零分配（`policy.go:15-59`）：`CompiledPolicy{Subject{AnyRole,AnyAgent,AnySubject}, Tool{AnyTool,PrefixTool}, Conditions[]{Field,Operator,Value}, Verdict, Obligations, Approvers, Priority, Version}`。`Condition` 的 `Field` 是闭集字符串枚举（`rag_provenance | recovery_cost | cross_tenant | scope | tenant | data_class | namespace | time_of_day | agent_risk_level | agent_capability | delegation_depth | fingerprint_drift | integrity_*`），`Operator ∈ {eq,ne,gt,gte,lt,lte,in,not_in}`；`Condition.matches`（`policy.go:125-195`）逐字段比对，不可解析阈值一律不命中（fail-safe）。`AgentRiskLevel` 用 `riskRank` 把 low<medium<high<critical 映成序数再比较（`policy.go:199-241`）。

**Rego 不是手写、而是由 AST 生成**：`CompiledPolicy.CompileRego()`（`policy.go:302`）把同一份 AST 渲染成 Rego 片段（与可视化 UI 旁只读面板一致）；`CompileRegoModules`（`rego.go:36-85`）把租户全部片段合并进单一 `package deepintshield.authz`，前置 `default decision := DENY`、`roles_of/role_of`、`risk_rank` 序数表，加载期一次性 `PrepareForEval`；求值时 `input` 即 `DelegationContext`（`rego.go:100-137`，agent_capabilities 统一小写以实现大小写不敏感的 `in`）。高阶用户也可直接贴原生 Rego，创建/更新时先用 OPA 编译校验（`agentic_decide.go:247-253,293-298`）。**AST 求值器作为 Rego 编译/求值失败时的兜底**（`policy.go:445-464`）。

## 决策流程

入口 `Runtime.Decide(ctx, DelegationContext) Decision`（`decide.go:285`），传输层 `POST /api/agentic-security/decide`（`agentic_decide.go:145-176`）。边界划分得很干净：**传输层只解 JSON、从中间件注入 tenant/workspace/VK，判定全在进程内 `agentic.Runtime`**。判定顺序（`decide.go:285-455`）：

1. **身份富化**（进判定前）：经 `VKResolver` 用 O(1) `sync.Map` 从 VK 行补 tenant/workspace/provider + agent ABAC 属性（`vk_resolver.go:26-48` 的 `VKScope`），SDK 显式给的值优先。
2. **服务端派生 ABAC**：`HourOfDay`、按租户是否用 `time_of_day` 决定 `CacheBucket`、`DelegationDepth=len(ActorChain)`。
3. **L1 决策缓存命中即返回**（O(1)、无锁、无网络）；命中不重写审计（首次 miss 已写，`decide.go:351-356`）。
4. miss：读该租户 `PolicySet`、工具 `ToolTier`、`EnforcementMode`；补 `DataClass`；若工具有 pinned 指纹则重算并置 `FingerprintDrift`（`decide.go:364-378`）。
5. **cheapest-deny-first 短路**（先便宜后贵）：① 工具 ∉ `AllowedTools` → DENY；② `CrossTenant` → DENY（`decide.go:385-408`）。
6. **策略求值**：先用 `PolicyTargetResolver.Resolve(vk,team,member)` O(1) 过滤出适用于该调用者的策略 ID（`policy_target_resolver.go:46-83`），交 `PolicySet.Evaluate`（`policy.go:445`）：**Rego 优先（权威），AST 兜底；闭集默认 DENY；首个按 priority 命中的规则胜出**。随后并集 tool-tier 的义务。
7. **Autonomy budget**：`recovery_cost=high` 把 ALLOW 降级为 REQUIRE_APPROVAL（`policy.go:482-490`，`AutonomyBudget` 见 `context.go:180`）。
8. **EnforcementMode**：`shadow` 永不拦截，置 `WouldBlock` 后改 ALLOW（用于误报度量）；`canary/enforce` 落真判定（`decide.go:442-445`）。
9. **fail-closed**：高敏工具且无策略集 → DENY（`decide.go:448-451`）。

**进程/模块边界**：PDP 是 server 进程内一个无传输依赖的包（刻意不含 fasthttp，`context.go:12-13`），传输层只做薄适配；guardrail（内容扫描）在**另一进程** `deepintshield_guard`，与 PDP 是两条独立链路（README 架构图 `README.md:96-105`：`VK → Guardrails → PDP → Router`）。这正是 AgentFence 要学的"安全逻辑放独立的 PDP 边界，而非塞进 Judge"。

**缓存策略**（`decision_cache.go`）：W-TinyLFU（theine-go），O(1) 免锁读、内部分片；TTL 上限 = revocation SLA（默认 30s，`decide.go:107-109`），`SetWithTTL` 权重 1；缓存键 = `sha256(actor_chain, tool, args_digest, scope_hash, policy_version, tenant, virtual_key, integrity_ruleset_version, cache_bucket, tool_fingerprint)`（`context.go:133-154`）——**`policy_version` 进键使策略更新成为"结构性失效"，无需显式清缓存**；`InvalidateTenant` 因无租户索引做保守全清（`decision_cache.go:85-105`）。

**Audit 落盘环节**：判定在 `finalize`（`decide.go:510`）里**先异步入队审计、再写缓存、最后返回**——audit 是 fire-and-forget，不阻塞热路径。`AsyncAudit`（`audit.go:67`）= 有界内存队列（默认 4096）+ N 个后台 drain worker（各 5s 写超时）。三种 backpressure 模式（`audit.go:37-43`）：`best_effort`（满则丢弃，绝不影响判定）、`durable`（溢写磁盘 NDJSON + janitor 重放，`audit.go:187,211`）、`fail_closed`（durable 之上，审计无法保证时把非 DENY 改写为 DENY，`decide.go:512-517`）。`AuditRecord`（`decide.go:74-100`）；真正落盘在持久层：`TableAgenticDecision`（`agentic_security.go:651-690`）——append-only、`prev_hash/hash` 哈希链防篡改、per-tenant 链、只存 `args_digest`。

## 可借鉴点 / 不可照抄点

### 可借鉴（对 AgentFence：Go，`internal/policy` + OPA/Rego 规划）

1. **PDP 是纯函数边界**：`Decide(DelegationContext) Decision`，规范化输入、不碰 wire token、无网络跳转（`context.go:6`）。AgentFence 应把 ALLOW/REVIEW/DENY 判定做成 `internal/policy` 里独立于 HTTP/工具细节的进程内纯函数。
2. **类型化 AST + 生成式 Rego 双轨**：同一份结构化规则既编译成零分配 Go AST（快路径），又生成可读 Rego（权威/对人），AST 作 Rego 失败兜底。直接呼应 AgentFence 的 OPA/Rego 规划，可照此组织 `internal/policy`。
3. **闭集判定模型**：Verdict/Condition-field/Operator 全是闭集枚举，不可解析输入 fail-safe 不命中。AgentFence 的 ABAC 字段也该闭集化，避免开放式解释器。
4. **语义缓存键 + version 进键**：`sha256(actor,tool,args_digest,scope_hash,policy_version,…)`，version 进键 = 策略更新即结构性失效；`args_digest`（sha256，不存原始参数）兼顾零数据保留与键稳定性。AgentFence 缓存判定可复用这套键设计。
5. **cheapest-deny-first**：先做 allow-list/归属这类 O(1) 短路，再进 Rego。省钱且快。
6. **判定顺序固定且显式**（短路→策略→义务并集→autonomy budget→mode→fail-closed），便于审计与排错；AgentFence 的判定管线可照搬这个骨架。
7. **Autonomy budget 即 REVIEW**：`recovery_cost=high` 把 ALLOW 降级为 REQUIRE_APPROVAL，是把"需人工复核"建模为策略后果而非独立通道，与 AgentFence 的 REVIEW 一致。
8. **shadow/canary/enforce 三态**：shadow 只标 `would_block` 不拦截，用于上线前测误报率。AgentFence 策略灰度可借鉴。
9. **审计异步 + 背压模式**：审计出热路径；`best_effort/durable/fail_closed` 三档可选，`fail_closed` 保证"无审计不执行"。AgentFence 审计不该阻塞工具调用。
10. **fail-closed on 策略缺失**：高敏工具无策略即 DENY。

### 不可照抄（自托管网关专属，嵌入式边界不需要）

1. **Virtual Key / 多租户 / workspace / 跨租户隔离**：`VKResolver`、`PolicyTargetResolver`、per-tenant policy set、cross-tenant guard、4 层隔离。AgentFence 是单租户嵌入式边界，无需这套身份/归属体系。
2. **两进程拆分 + server↔guard 的 gRPC `runtimeapi`**：分布式网关的部署形态；AgentFence 进程内即可，不必拆进程。
3. **HTTP 传输层 / fasthttp / 可视化规则 UI / GitOps 发布生命周期（draft/staged/published）/ dashboard**：网关产品形态。AgentFence 以配置文件 authoring 策略即可，无需 UI 与发布工作流。
4. **哈希链 DB 持久化（GORM）、configstore、迁移**：合规证据链落在数据库；嵌入式边界记结构化日志/文件即可，无需 DB。
5. **W-TinyLFU（theine-go）+ revocation SLA / CAEP-SSF 推送 + VK 驱动的租户失效**：为高并发多 agent 网关设计；AgentFence 进程内判定本就廉价，用更简单的 LRU 甚至不缓存。
6. **MCP 网关与工具治理、Provider 路由、语义缓存、幻觉控制、OTel 导出器**：均超出 AgentFence 的策略边界范围（注：MCP 网关在其 OSS 版中本就标为 Cloud/Enterprise，`README.md:432`）。
7. **OTel/Datadog/Langfuse 观测 sink**：网关级运维诉求；AgentFence 只需结构化判定日志。

### License 约束

Apache-2.0：宽松、非 copyleft，可自由借鉴模式甚至拷贝代码片段；若拷贝实质代码须保留版权头与 `NOTICE`（其自身亦保留对上游 Bifrost/Maxim HQ 的归属）。Copy 模式无约束，Copy 代码需归属。
