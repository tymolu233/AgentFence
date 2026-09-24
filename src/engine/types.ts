/**
 * Engine 编排层类型：ACL 配置 + createEngine 的选项与接口。
 * 管线顺序与短路语义见 engine.ts 顶部注释；
 * 判定契约（ToolCall / Decision）权威定义在 src/api/types.ts。
 */
import type { Decision, ToolCall } from "../api/types.js";
import type { AuditQueue } from "../audit/index.js";
import type { Judge, Thresholds } from "../judge/index.js";
import type { PolicyEngine } from "../policy/index.js";
import type { Rule } from "../rules/schema.js";
import type { SessionStore } from "../session/index.js";

/**
 * 单个 agent 的 ACL 条目。语义（检查顺序即下列顺序）：
 *
 * - `deny`   工具黑名单：命中即 DENY，优先于一切 allow 配置。
 * - `tools`  按工具名的细粒度开关：`{ shell: { allowed: false } }` 即
 *            "research agent 禁止 shell"，直接 DENY。
 * - `allow`  工具白名单：配置后，不在列表内的工具一律 DENY；
 *            未配置（undefined）则不限制。空数组等于"禁止全部工具"。
 *
 * 工具名匹配 `ToolCall.tool.name` 或 `tool.category`（小写比较），
 * 与规则层 match.tool 的路由语义一致。
 */
export interface AgentAcl {
  deny?: string[];
  allow?: string[];
  tools?: Record<string, { allowed: boolean }>;
}

/**
 * ACL 层配置（管线第一层，成本最低）。
 *
 * - `agents` 按 `agent_id` 精确匹配；
 * - 未配置的 agent 回落到 `default` 条目；
 * - `default` 也未配置时该 agent 无 ACL 限制，放行到后续层
 *   （ACL 是收口手段而非默认门禁；默认拒绝由 policy 的 fail_closed 承担）。
 */
export interface AclConfig {
  agents?: Record<string, AgentAcl>;
  default?: AgentAcl;
}

/** Judge 层接线配置。judge 默认关闭（enabled: false），跳过整层。 */
export interface JudgeOptions {
  enabled: boolean;
  /** enabled: true 时必须提供；缺失视为 judge 调用失败，按 fail_closed 处理 */
  judge?: Judge;
  /** decide 的阈值覆盖；缺省用 DEFAULT_THRESHOLDS */
  thresholds?: Partial<Thresholds>;
  /** judge 调用失败/超时时的去向：true（默认）→ DENY；false → ALLOW */
  fail_closed?: boolean;
  /** assess 超时毫秒数，默认 5000 */
  timeout_ms?: number;
}

export interface EngineOptions {
  /** 已加载的规则（loadRules 产物，按 priority 升序） */
  rules: readonly Rule[];
  /** 已创建的策略引擎（createPolicyEngine 产物） */
  policy: PolicyEngine;
  /** 写进 Decision.policy_version / 审计；缺省不带该字段 */
  policyVersion?: string;
  acl?: AclConfig;
  judge?: JudgeOptions;
  /**
   * 会话上下文存储（src/session/）。配置后：check() 对带 session_id 的
   * 调用注入 store.snapshot()（覆盖调用方自报的 call.session，不变量 3），
   * 判定落定后回写 tool+decision。未配置则 session 功能整体关闭
   * （call.session 原样透传——适配层本来就不填它）。
   */
  sessionStore?: SessionStore;
  /** 全量审计队列（ALLOW 同记）；由调用方拥有，engine.close() 会关闭它 */
  audit: AuditQueue;
}

export interface Engine {
  check(call: ToolCall): Promise<Decision>;
  /** 关闭审计队列（落盘全部积压）；进程退出前必须调用 */
  close(): Promise<void>;
  /**
   * 配置的 SessionStore（未配置则缺省）。判定的注入与回写由 engine 内部
   * 完成；暴露它是为了让 hook 层在用户消息事件（UserPromptSubmit）时
   * appendUserMessage（见 integrations/core/hook.ts）。
   */
  readonly session?: SessionStore;
}
