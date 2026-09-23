/**
 * Policy 层契约类型。
 * 设计蓝本：docs/research/deepintshield.md（PDP 纯函数边界、cheapest-deny-first、
 * shadow/enforce、autonomy budget、fail-closed on 策略缺失）。
 * 策略维度：docs/vision.md 第 8 节（Agent × Target × Tool × Action × Environment × Risk）。
 *
 * 本层是进程内纯函数：不碰网络/文件/时钟（时钟由参数注入），
 * 不 import src/rules（并行开发中），规则层结论以最小类型传入。
 */
import type { DecisionKind, RiskLevel, ToolCall } from "../api/types.js";

export type { DecisionKind };

/** 规则层结论的最小输入（自定义，勿 import src/rules） */
export interface RulesOutcome {
  verdict?: DecisionKind;
  risk?: RiskLevel;
  matched_rules?: string[];
}

/** 策略求值的规范化输入 */
export interface PolicyInput {
  call: ToolCall;
  rules?: RulesOutcome;
  /** 注入时钟（epoch ms）；仅用于审计字段，不参与判定 */
  now?: number;
}

/** 策略层输出：部分 Decision 语义；null = 策略无意见，交给后续层 */
export interface PolicyVerdict {
  verdict: DecisionKind;
  reason: string;
  policy_id: string;
  /** shadow 模式标记：本会被拦截，实际放行 */
  would_block?: boolean;
}

export type EnforcementMode = "enforce" | "shadow";

/** 环境名闭集（loader 校验用；求值时未知环境按无环境策略处理） */
export const ENVIRONMENTS = ["sandbox", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** 动作类别闭集：规则层/适配器把具体动作归一到这些类别 */
export const ACTION_CLASSES = [
  "read",
  "write",
  "destructive",
  "credential_access",
  "network_exfiltration",
  "reverse_shell",
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

/** 条件字段闭集（vision.md 第 8 节六维） */
export const CONDITION_FIELDS = [
  "agent",
  "target",
  "tool",
  "action",
  "environment",
  "risk",
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

/** 条件算子闭集；不可解析输入一律不命中（fail-safe） */
export const CONDITION_OPERATORS = ["eq", "ne", "in", "not_in"] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export interface PolicyCondition {
  field: ConditionField;
  operator: ConditionOperator;
  /** eq/ne 用标量；in/not_in 用数组 */
  value: string | string[];
}

/** 一条策略规则：全部条件命中（AND）即产出 verdict */
export interface PolicyRule {
  id: string;
  /** 数字小者先判；首个命中的规则胜出 */
  priority: number;
  verdict: DecisionKind;
  conditions: PolicyCondition[];
  reason?: string;
}

/** 环境策略简写：某环境下某动作类别的默认判定 */
export type EnvironmentPolicy = Partial<Record<ActionClass, DecisionKind>>;

/** autonomy budget：高危风险把 ALLOW 降级为 REVIEW */
export interface AutonomyBudget {
  /** 达到该风险等级即降级（闭集：HIGH | CRITICAL） */
  downgrade_allow_at: "HIGH" | "CRITICAL";
}

export interface PolicyConfig {
  version: number;
  /** fail_closed：策略缺失且工具高危时默认 DENY */
  mode: "fail_closed";
  enforcement: EnforcementMode;
  policy: Partial<Record<Environment, EnvironmentPolicy>>;
  rules: PolicyRule[];
  autonomy_budget?: AutonomyBudget;
  /** 工具白名单；配置后不在其中的工具直接 DENY（cheapest-deny-first 短路） */
  allowed_tools?: string[];
}

/** 工具高危判定用的风险阈值：达到即视为高危 */
export const HIGH_RISK_THRESHOLD: RiskLevel = "HIGH";

const RISK_ORDER: Record<RiskLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export function riskAtLeast(risk: RiskLevel, threshold: RiskLevel): boolean {
  return RISK_ORDER[risk] >= RISK_ORDER[threshold];
}
