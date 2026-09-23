# Guardian (LegionForge/guardian) 调研报告

- 仓库: https://github.com/LegionForge/guardian （PyPI 包名 `legionforge-guardian`，版本 4.0.0）
- Commit: a6fc62af6472cebfd94b3f2810c91de26cb4e36e（2026-09-16，main HEAD）
- License: MIT（Copyright (c) 2026 John Paul "Jp" Cruz）
- 语言: Python 3.11+（FastAPI + psycopg3 + PyJWT，独立 sidecar 监听 127.0.0.1:9766）
- 定位: "Deterministic security sidecar"——工具执行前跑 7 个确定性检查，全程无 LLM，规则不可被 prompt injection 绕过

## Tool Call 数据结构

Guardian 不直接包在 agent 框架里，而是通过 HTTP `/check` 接收一次工具调用裁决请求。请求模型（`src/legionforge_guardian/app.py:583-590`）：

- `tool_id: str`、`action: str`（通常为 `"invoke"`）、`args: dict`
- `agent_id: str`、`run_id: str`（用于按 agent 查序列契约、写审计）
- `sequence_so_far: list[str]`——本次 run 已执行的工具序列，由调用方维护并上报（sidecar 无状态，自己不追踪会话）
- `task_token: str | None`——Phase 3 引入的 JWT 任务令牌，可选（不传则跳过 Check 0，向后兼容，`app.py:625-626`）

响应模型（`app.py:593-598`）：`allowed: bool`、`tier`（`"allow" | "sandbox" | "halt"` 三档，非二元）、`reason`、`threat_type: str | None`、`confidence: float`。

**Tool Registry 数据模型**（`init.sql:11-21`，Postgres 表 `tool_registry`）：`tool_id` 主键、`status ∈ {APPROVED, REVOKED, PENDING}`、`description_hash` / `schema_hash` / `entrypoint_hash`（防篡改指纹）、`signature`、`registered_at` / `approved_at`。Guardian 每 10s 把 `APPROVED` 工具的哈希与 `REVOKED` 集合刷进内存缓存（`app.py:501-509`），热路径不碰 DB。

**Task token（JWT scope）模型**（`app.py:272-284`）：HS256 签名，共享密钥即 `TASK_TOKEN_SECRET` 环境变量（与 Bearer 鉴权同一个密钥，`app.py:295`、`app.py:412`）；强制声明 `exp/iat/jti/sub/iss`（`app.py:305`），iss 须匹配 `TASK_TOKEN_ISSUER`（默认 `legionforge`）。scope 由三个授权列表构成：`granted_tools`（可调用工具白名单）、`granted_tables`、`granted_data_classes`，外加 `parent_token_id`（支持令牌派生链）与 `escalation_policy`（默认 `"deny"`）。当前代码只强制检查了 `granted_tools`（`app.py:638`）。

**序列契约模型**（`init.sql:40-45`，表 `agent_profiles`）：`(agent_id, sequence TEXT[])` 二元组——每个 agent 注册若干条"剧本式"合法工具序列。

## 决策流程

7 个检查按编号顺序执行、fail-fast 短路，任一检查返回响应即终止后续检查（`/check` 端点编排，`app.py:1193-1359`）。有序的产出类型让 cheap 的检查（本地数据比对）在前、regex 扫描靠后：

| # | 检查 | 短路产出 | 位置 |
|---|---|---|---|
| 0 | Task token：JWT 签名/过期/iss 校验 + `tool_id ∈ granted_tools` | halt（INVALID_TASK_TOKEN / TOOL_SCOPE_VIOLATION） | `app.py:611` |
| 1 | Tool Registry：先查 REVOKED（吊销优先于批准），再查是否在 APPROVED 注册表 | halt（TOOL_REVOKED / CAPABILITY_VIOLATION） | `app.py:653` |
| — | 金丝雀检查（夹在 1、2 之间）：`guardian_canary` 已 seed 进注册表但任何合法代码都不该调用它，调用即探测/幻觉证据 | halt + 异步写 threat_events（CANARY_TRIGGERED） | `app.py:1248-1272` |
| 2 | Capability 边界：`action` 或 `tool_id` 命中 7 项禁能（`register_tool`、`write_executable`、`invoke_unregistered`、`modify_registry`、`escalate_scope`、`spawn_agent_direct`、`modify_own_state`） | halt（CAPABILITY_VIOLATION） | `app.py:115-125`、`app.py:681` |
| 3 | 破坏性模式：对 `json.dumps(args)` 跑 9 个 regex 族（凭证探测、内网探测、系统路径、批量破坏、自我探测、命令注入、提权、数据外发 staging、侦察） | 命中 FORCE_END 四类（CMD_INJECTION/SELF_PROBE/DATA_STAGING/PRIVILEGE_ESCALATION）→ halt；其余命中只 LOG 放行（后台异步上报） | `app.py:138-252`、`app.py:853` |
| 4 | 序列契约：`sequence_so_far + [tool_id]` 必须是该 agent 某条已注册序列的前缀；agent 无注册序列则不约束（渐进接入） | sandbox（SEQUENCE_VIOLATION）——唯一输出 sandbox 的静态检查 | `app.py:885` |
| 5 | 哈希完整性：比对 DB 缓存哈希与进程内注册哈希，不一致即工具被篡改 | halt（TOOL_HASH_MISMATCH）；standalone 模式下进程内注册表为空，实际 no-op | `app.py:918` |
| 6 | 自适应规则：DB `threat_rules` 表热加载（10s TTL）的人审批准规则，类型 CAPABILITY_BLOCK（halt）/ INJECTION_PATTERN（halt，confidence 0.95）/ SEQUENCE_BLOCK（sandbox）；regex 坏了跳过不崩 | halt / sandbox | `app.py:948` |

全部通过 → `{allowed: true, tier: "allow"}`（`app.py:1352-1358`）。

**Sidecar 边界与通信协议**：主 agent 进程在每次工具执行前同步 POST `/check`（SDK `GuardianClient`，`src/legionforge_guardian/sdk/client.py:60`）；另有异步 POST `/report`（写带 SHA-256 哈希链的 `audit_log`，`app.py:784-850`）、GET `/rules`（只读视图）、GET `/health`、`/metrics`、`POST /invalidate-cache`。Guardian 用自己独立的 psycopg 连接直连 Postgres，不依赖主框架连接池（`app.py:467-479`），仅绑 127.0.0.1。传输鉴权是 `Authorization: Bearer <TASK_TOKEN_SECRET>`，`hmac.compare_digest` 防时序枚举（`app.py:453`）。

**异常路径行为（fail-closed）**：
- 鉴权配置缺失（REQUIRE_AUTH=true 但无 secret）→ halt（GUARDIAN_MISCONFIGURED，`app.py:1203-1213`）；Bearer 错误 → halt（GUARDIAN_AUTH_FAILURE）
- SDK 侧网络错误/超时（默认 2s）→ 合成 halt 响应（GUARDIAN_UNREACHABLE），绝不 raise、绝不放行（`sdk/client.py:93-102`）
- DB 缓存刷新失败 → 沿用旧缓存，不 crash（`app.py:563-571`）；审计/威胁事件写入失败只记 warning，不阻塞热路径（`app.py:755-757`）
- 未知工具拒绝、未知序列 sandbox、`/health` 自我报告 degraded（DB 不可达或缓存 >30s，`app.py:1102`）

## 可借鉴点 / 不可照抄点

**可借鉴：**
1. **"不依赖 LLM"的落地方式**值得整体参照：判定函数全部是数据比对 + regex + JWT 验签，纯函数式 `_check_N(...) -> Response | None`（`app.py:608` 注释），安全边界完全在 LLM 上下文之外。AgentFence 的 deterministic 层应同样保证策略评估不读任何可被注入的模型输出文本——Guardian 连 args 都只做字符串模式匹配，不做语义判断。
2. **三档 tier（allow/sandbox/halt）而非二元**，且把 sandbox 绑定到"novel sequence"这类"不确定但非恶意"场景——正好映射 AgentFence 的 REVIEW 档，可作为 ALLOW/REVIEW/DENY 的判据设计参考。
3. **Tool Registry 数据模型直接可用**：`tool_id + status(APPROVED/REVOKED/PENDING) + description_hash/schema_hash/entrypoint_hash`，吊销集合先查、缓存 10s TTL、提供 `/invalidate-cache` 立即失效端点。AgentFence 的 Tool Registry 可照此建模。
4. **Task token = 短期 JWT 携带 granted_tools 白名单**，把"这次任务允许哪些工具"从全局 ACL 收缩到 per-run scope；检查逻辑极薄（`app.py:638` 一次 `in` 判断）。
5. **客户端 fail-safe 的合成 halt**：sidecar 不可达时由 SDK 生成拒绝响应而非抛异常，调用方只需检查 `result["allowed"]` 一个布尔——这个"调用方心智负担最小化"的协议设计对我们 SDK 同样适用。
6. **金丝雀工具**（注册但永不合法调用）成本极低，可作为 AgentFence 检测 agent 幻觉/探测的探针。
7. **审计哈希链**（每行含 prev_hash 的 SHA-256 链，`app.py:776-781`）让审计日志可离线验证。

**不可照抄：**
1. **传输鉴权与 JWT 验签共用同一个密钥** `TASK_TOKEN_SECRET`（`app.py:295` 与 `app.py:412`）：知道验签密钥就能签发任意 scope 令牌，也能调用 sidecar。AgentFence 应分离"sidecar 传输凭证"与"令牌签发密钥"。
2. **Check 0 默认跳过**（无 token 的 agent 不受 ACL 约束，仅"向后兼容"，`app.py:625-626`）；**Check 4 对无注册序列的 agent 不约束**（`app.py:896-898`）。两个口子都意味着默认姿态不是全量 fail-closed，我们不能继承这种渐进式妥协。
3. **`sequence_so_far` 由调用方自报**，被攻陷的 agent 可以谎报序列绕过 Check 4。序列状态应由网关侧按 run_id 维护，而非信任上报。
4. **regex 黑名单式模式检测**（9 族，Check 3）天然可被改写绕过（同义词、编码、分片），只能当尽调层，不能当主边界；Guardian 自己也只把其中 4 类判 halt，其余降级为 LOG 放行。
5. **Check 5 在 standalone 部署下是 no-op**（`_TOOL_HASHES` 恒为空，`app.py:927-929`），哈希完整性只在与 LegionForge 主进程同驻时有效——分离部署时这一层直接消失，暴露了"进程内状态"与"sidecar"架构的耦合缺陷。
6. **Postgres 强依赖**：裁决规则存 DB + 10s 轮询缓存，吊销传播最坏 10s。AgentFence 若要更轻，可用本地文件/SQLite + 主动失效；但"吊销优先于批准、带 TTL。”的缓存语义值得保留。
7. **SDK/README 文档与实际接口不一致**（README 示例用 `tool_name`/`tool_input`/`agent_state` 参数，真实 SDK 是 `tool_id`/`action`/`args` 等）——提醒我们文档与代码须同改。

**License 约束**：MIT，可自由借鉴设计与数据模型；若直接复制代码（如 9 族 regex 表、哈希链实现），须保留 MIT 版权声明（Copyright (c) 2026 John Paul "Jp" Cruz）。
