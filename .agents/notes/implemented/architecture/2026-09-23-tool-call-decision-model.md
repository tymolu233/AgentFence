# Agent Note: Tool Call 与 Decision 数据结构 v1

Status: implemented

## Problem

多 agent 适配要求所有宿主的 tool call 方言归一为单一判定输入；审计与判定缓存需要稳定键；六份调研暴露了一批必须成文的安全不变量（调用方自报不可信、tool result 冒充用户发言等）。

## Decision

统一判定契约 v1（实现在 `src/api/types.ts`）：`ToolCall{request_id, agent_id, session_id, run_id, tool{name,action,category}, input, input_digest, context{environment,target,cwd,trust_level,task_token}, session{user_intent,recent_tool_calls,flagged_untrusted}}`；`Decision{decision: ALLOW|REVIEW|DENY, risk: LOW|MEDIUM|HIGH|CRITICAL, confidence, matched_rules[], decision_layer, reason, latency_ms, policy_version}`。`decision_layer` 记录哪一层作出判定；shadow 模式拆 `raw_decision`/`effective_decision`。

六条不变量（违反即 bug）：

1. 判定逻辑是进程内纯函数，传输层只做薄适配；
2. trust 由网关侧裁定，调用方只能自报更低；
3. 运行时状态（调用序列、session）由网关侧维护，不信任调用方自报；
4. tool result 内容永不算用户发言；
5. fail-closed：解析失败、策略缺失、网关不可达（SDK 合成 DENY）默认拒绝；
6. 审计全量（ALLOW 同记）、异步出热路径。

## Alternatives considered

- **直接沿用 jev-guard 归一结构** — 缺 input_digest、trust、task_token，session 结构很好故以其为骨架。
- **沿用 DeepintShield DelegationContext** — 绑定多租户/VK 体系，超出嵌入式边界；只取 args_digest 与闭集 ABAC 思路。
- **沿用 Guardian /check 请求** — 缺 session 上下文，且 sequence 自报是反面教材。

## Consequences

正面：适配器映射目标唯一，审计/缓存键稳定。代价：字段变更是破坏性变更，须升 `policy_version` 并同步全部适配器。强制要求：任何新字段进契约前先回答"六条不变量是否仍然成立"；依据与字段出处见 `docs/research/synthesis.md`。
