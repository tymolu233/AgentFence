# AgentGuard 双仓调研报告（A5）

两个同名项目，互补性强：W 偏"四段介入 + 平台化管控"，H 偏"trust 分级 + 三层级联判定 + 防篡改审计"。下文引用以【W】/【H】标注仓库，行号基于各自 commit。

## 元信息

| | 【W】WhitzardAgent/AgentGuard | 【H】hidearmoon/agentguard |
|---|---|---|
| 仓库 | https://github.com/WhitzardAgent/AgentGuard | https://github.com/hidearmoon/agentguard |
| Commit | `cad3f409a5189a0512e2ae7dad621bc4ec8ec7ac`（2026-09-20，main HEAD，`--depth 1`） | `9d8b9f99e094a93a7feb2f2b1e88e8f91a2e608b`（2026-05-09，main HEAD，`--depth 1`） |
| License | **GPL-3.0**（`LICENSE`；有传染性，只看思路不复制代码） | **Apache-2.0**（`LICENSE`；宽松，可借鉴实现细节） |
| 语言/形态 | Python（≥3.11）+ 少量 JS 客户端；client SDK + FastAPI 控制面 server + Web 控制台 | Python 3.12+ monorepo：core 引擎（FastAPI）、SDK Py/TS/Go、sidecar proxy、React console、平台集成包 |

## Tool Call 数据结构

### 【W】统一事件 + 决策模型

- 四类事件覆盖四段介入：`EventType = LLM_INPUT | LLM_OUTPUT | TOOL_INVOKE | TOOL_RESULT`（【W】`src/shared/schemas/events.py:15-19`）。`ToolInvoke = {tool_name, arguments, capabilities[]}`（`events.py:91-102`）；`RuntimeEvent = {event_id, event_type, timestamp, context, payload, risk_signals[], metadata}`，内置密钥/卡号正则脱敏 `redacted()`（`events.py:117-131`）。
- 上下文 `RuntimeContext = {session_id, user_id, agent_id, task_id, policy, policy_version, environment, metadata}`（`src/shared/schemas/context.py:8-19`）；principal（含 `trust_level`）塞进 `context.metadata.principal`（`src/client/python/agentguard/compat.py:30-41`）。
- 决策 `GuardDecision{decision_type, reason, policy_id, confidence, risk_signals, metadata}`，`DecisionType` 共 13 种：ALLOW/DENY/SANITIZE/REWRITE/REPAIR/DEGRADE/HUMAN_CHECK/REQUIRE_APPROVAL/REQUIRE_REMOTE_REVIEW/LOOP_BACK_TO_LLM/DROP_THOUGHT/ALIGN_THOUGHT/LOG_ONLY（`src/shared/schemas/decisions.py:9-26`）。
- 规则 DSL：`RULE / TRACE: A -> ...? -> B / CONDITION / POLICY: DENY / Severity / Category / Reason`，TRACE 支持 `->`、`-> *`、`-> ...`、`-> ...?` 四种链式间隔符做跨工具链匹配（`src/shared/rules/trace_pattern.py:1-9`）；条件是绑定到 trace 占位符（如 `Retriever.name`）与 principal 属性的点路径谓词（`src/shared/schemas/policy.py:46-58`）
- 审计：`AuditTraceEntry{session_id, agent_id, user_id, reason, event, decision, plugin_result, plugin_input, route, timestamp}`（`src/server/backend/audit/base.py:31-42`）；客户端为 append-only JSONL（`src/client/python/agentguard/audit/logger.py`）。无哈希链，防篡改能力弱于 H。

### 【H】ToolCall / 权限 / 审计三元组

- `ToolCall{name, params, tool_category, estimated_result_size}`（【H】`packages/core/src/agentguard_core/engine/intent/models.py:42-47`）；`Intent{intent, expected_tools[], sensitive_data_involved}` 会话开始由 LLM 抽取（`engine/intent/engine.py:105-133`）。
- Trust 五级枚举 `TRUSTED=5 … UNTRUSTED=1` + `source_id → trust` 映射表（通配符 `email/*`、`web/*`）（`engine/trust/levels.py:8-31`）；**trust 服务端计算，客户端只能降级不能升级**（`engine/trust/marker.py:46-76`）。
- 权限：每级 trust 一对 allowlist/blocklist（EXTERNAL 阻断 `send_email/query_database/execute_code/call_api/write_file`）（`engine/permissions/dynamic.py:12-27`），`get_available_tools(trust, intent, agent_tools)` 动态收缩（`dynamic.py:39-71`）。
- 审计：`TraceSpan{trace_id, span_id, agent_id, session_id, span_type, intent, intent_drift_score, data_trust_level, tool_name, tool_params, decision, decision_reason, decision_engine, start/end_time, merkle_hash}`（`engine/trace/models.py:9-28`）；**Merkle 链**：`sha256(prev_hash|trace_id|span_id|tool_name|decision|start_time)` 逐 span 链式，`verify_chain()` 重放校验（`engine/trace/merkle.py:22-47`）。
- 自定义策略 YAML DSL：`when:{tool|tool_category, trust_level[], params.<field>.{equals|matches|contains|gt|lt|in…}, conditions[]}`（`policy/dsl.py:1-50`）。

## 决策流程

### 【W】四段介入 × client/server 双层

介入点能拿到的数据：llm_before=完整 messages；llm_after=output/thought/final_output（能从 ReAct 文本与 `reasoning_content` 提取 thought）；tool_before=tool_name+arguments+capabilities+trajectory window；tool_after=result/error（`events.py:59-112`）。

1. 事件在 client 侧按 phase 过本地插件（可打 risk_signal、可给出 final 决策）（`u_guard/enforcer.py:69-93`）。
2. 本地无 final → 携带 `trajectory_window + local_signals + 缓存条目` 走 `POST /v1/server/guard/decide` 上送 server（`shared/protocol/messages.py:12-30`）。
3. Server 按 phase 配置跑插件链，`stop_on_first_decision=True` 短路（`runtime/manager.py:489-494`）；规则匹配"优先级优先、平级 DENY 最重"（`shared/rules/matcher.py:10-18, 42-57`）；`llm_check` 类规则升级为 LLM 复核，复核失败降级为原判定（`tool_before/rule_based_plugin/plugin.py:124-200`）；REVIEW 类决策生成 ticket 进入人工审批队列，仅升级不降级已有更重判定（`manager.py:501-547`）。
4. 无任何插件给出 final → **默认 ALLOW**（`manager.py:778-786`）。
5. 降级行为：路由层按"final 本地判定 > 确定本地 DENY > 高危/不确定走远端 > 远端不可用走 fallback"（`u_guard/router.py:53-79`）；fallback 支持 fail_closed（高危 DENY）/fail_open（`u_guard/fallback.py:20-36`，`Guard(fail_open=…)` 暴露给用户）；远端报错 → 返回 `REQUIRE_REMOTE_REVIEW`（`enforcer.py:143-149`）。DENY 在 LangChain 适配器中被翻译成 ToolMessage JSON 回喂 LLM（软阻断），也有抛 `DecisionDenied` 异常的硬阻断路径（`adapters/agent/langchain.py:769-811`）。

### 【H】单入口 Pipeline：trust → 权限 → 三层 intent → 写链

`Pipeline.check_tool_call`（`engine/pipeline.py:122-236`）：

1. 服务端按 `source_id` 算 trust（客户端声明值只能压更低）（`pipeline.py:141-148`）。
2. 权限预检：当前 trust 下工具不可用直接 BLOCK（短路，engine=permission）（`pipeline.py:150-162`）。
3. Intent 三层级联（`engine/intent/engine.py:59-98`）：
   - L1 规则引擎（µs 级）：按 priority 排序，首个命中即 definitive 返回（`rule_engine.py:76-92`）；
   - L2 异常检测（µs 级）：5 个加权特征（trust-动作失配 0.30、参数异常 0.25、intent 距离 0.20、工具类别新颖度 0.15、时序 0.10）打分（`anomaly.py:19-60`），并做**会话级风险累积**（`engine.py:76-84`）；
   - L3 语义检查（ms~s 级）：仅当 `0.6 ≤ score < 0.85` 时调 LLM 判定调用与原始 intent 的一致性；`≥0.85` 直接 BLOCK，不再花 LLM 钱（`engine.py:86-98`、`semantic.py`）。
4. 每次判定写 TraceSpan 进 Merkle 链，决策记录是哪个 engine 作出的（rule|anomaly|semantic|permission）（`pipeline.py:172-194`）。
5. 决策只有三值：ALLOW / BLOCK / REQUIRE_CONFIRMATION（`intent/models.py:9-12`）；CONFIRM 由 SDK 侧的 `confirm_callback` 落实，未提供回调则拒绝（`sdk-python/src/agentguard/shield.py:106-112`）。

## 适配机制

| 项目 | 目标 | 挂接方式 |
|---|---|---|
| 【W】 | LangChain / LangGraph / AutoGen / OpenAI Agents SDK / LlamaIndex / MetaGPT | 进程内**原地 monkey-patch**：反射找出 agent 的工具与 LLM，包装 `func/_run/invoke（ainvoke）` 注入 before/after 守卫（`attach_langchain` 等，`guard.py:222-290`；工具补丁偏好顺序 `langchain.py:585-603`） |
| 【W】 | Dify | **进程启动期安装运行时钩子**：import-hook 捕获 `app_factory.create_app`，patch Dify 内部 agent 节点（无用户侧 agent 对象可传，`adapters/agent/dify.py:1-20`、`dify_bootstrap.py`） |
| 【W】 | OpenClaw（JS） | **官方插件 SDK 生命周期钩子**：`before_tool_call→tool_before`、`after_tool_call→tool_after`、`before_agent_run→llm_before`、`message_sending→llm_after`（`src/client/js/agentguard/adapters/agent/openclaw-adapter-js/README.md`） |
| 【H】 | LangChain / CrewAI / AutoGen / Claude Agent SDK | 一行式 **Shield wrapper**：分别 patch `tool._arun`、`tool._run`、`agent.function_map`、SDK tool_handler 回调（`sdk-python/src/agentguard/integrations/{langchain,crewai,autogen,claude_agent}.py`） |
| 【H】 | MCP | 双模式：`@shield.guard` 装饰器（新 server）+ **stdio 代理**拦截 `tools/call` JSON-RPC（存量 server 零改动，`integrations/mcp/README.md`） |
| 【H】 | Dify | patch 单一汇聚点 `ToolEngine._invoke`，覆盖全部工具类型（`integrations/dify/agentguard_dify.py:118-183`） |
| 【H】 | OpenClaw / n8n / AutoGPT | 插件钩子 `before/after_tool_call`（TS）；n8n 社区节点按 allowed/blocked 路由；AutoGPT 安全检查 Block |
| 【H】 | 任意 agent | **SDK 装饰器 `@shield.guard` / 会话上下文 `shield.session(goal)`**（`shield.py:67-142`）+ 零改动的 **sidecar 反向代理**（FastAPI catch-all + 中间件链：剥头→限流→身份→安全检查，`packages/proxy/src/agentguard_proxy/app.py`）；另有不依赖 server 的 `LocalShield` 本地模式（`sdk-python/src/agentguard/local.py`） |

对 AgentFence 多 agent 适配器的借鉴结论：**收敛顺序应是"官方 hook > 框架回调/中间件 > 单点 chokepoint patch > 对象级 monkey-patch"**。【H】的 Dify `ToolEngine._invoke` 单点 patch 与 MCP stdio 代理两种思路最值得我们抄设计——前者证明找到框架内"所有工具调用必经的唯一入口"比一个工具一个工具地包更稳；后者对 MCP 场景零侵入。【W】的 OpenClaw 四钩子映射表证明"宿主生命周期钩子 ↔ 我方四段介入"可以一一对应，是我们 CLI agent（OpenCode/Claude Code 等）适配层的好范式。【W】的反射式深 patch（遍历 `nodes`/`builder` 找 ToolNode）代码量最大也最脆弱（langchain.py 一个文件 915 行），不建议优先走。

## 可借鉴点 / 不可照抄点

### 可借鉴（对 AgentFence 的具体启示）

1. **决策值域设计**：W 的 13 种 DecisionType 太碎；H 的 ALLOW/BLOCK/REQUIRE_CONFIRMATION 三值 + `decision_engine` 溯源字段更贴合我们 ALLOW/REVIEW/DENY 模型，建议决策对象里直接记录"谁（哪层）作出的判定"（H `pipeline.py:23-31`）。
2. **双层判定架构与我们天然契合**：本地确定规则短路 + 远端深判（W enforcer/router）；本地 LocalShield 无服务器可用（H local.py）——对应 CLI agent 离线场景，建议 AgentFence 本地引擎常驻、远端增强可选。
3. **trust 服务端裁定、客户端只能降级**（H `marker.py:46-57`）：防止 agent 自报高信任度提权，零信任建模的最小不变量，可直接采用该语义（Apache-2.0 亦可参考实现）。
4. **三层级联的成本/延迟分层**：规则（µs）→ 统计打分（µs）→ LLM 复核仅在中间灰区触发（H `engine.py` docstring `:27-30`）；加上"会话风险累积系数"，对我们的 REVIEW 判定节流很有用。
5. **Merkle 防篡改审计链实现极简**（H `merkle.py:22-47`，47 行）：顺序链 + `verify_chain` 重放校验，值得在我们审计模块直接实现同构设计。
6. **会话级意图基线**：会话开始记录 user goal（W `Guard.start(principal, goal=…)`；H `shield.session(goal)` + LLM 抽取 expected_tools），后续 tool call 与基线比对——与我们"判定要见上下文"的方向一致。
7. **CONFIRM/REVIEW 的回调通道**：H 用 `confirm_callback` 把"问人"做成 SDK 注入点而非框架特性；W 用 ReviewQueue + ticket 升级（不覆盖已更重判定）。两者可合并为我们的 REVIEW 通道设计。
8. **payload 脱敏内建**：W 事件模型自带密钥正则脱敏（`events.py:27-45`），审计落盘前的必备件。

### 不可照抄点（License 边界）

- **【W】整体 GPL-3.0**：不得复制、改写或"清洗式"移植其任何源码（含 `.rules` DSL 语法的直接搬用、适配器反射遍历代码、`compat.py`  facade 设计文本）；本报告引用的所有 W 侧行号仅用于事实性说明其机制，实现须按思路重写。若 AgentFence 采用 Apache-2.0/MIT，GPL 代码连" linking/衍生"边界都不能碰。其附带论文（arXiv 2605.28071）可作为无 license 障碍的思路来源。
- **【H】Apache-2.0**：可借鉴乃至引用代码，但须保留版权与 LICENSE 归属声明；注意其 monorepo 内含 React console、Go/TS SDK，借鉴时逐文件确认头注。
- 两者共同点 `agentguard` 包名与我们 AgentFence 无冲突，但 PyPI 上 `agentguardx` 已存在（H 包名），我方发布命名需避让。
