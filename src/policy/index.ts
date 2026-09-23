/**
 * Policy 层公共出口。
 * 引擎是进程内纯函数：decide(PolicyInput) → PolicyVerdict | null，
 * null = 策略无意见，交给后续层（judge/approval）。
 */
export { createPolicyEngine } from "./engine.js";
export type { PolicyEngine } from "./engine.js";
export type { PolicyEvaluator } from "./evaluator.js";
export {
  StructuredEvaluator,
  applyAutonomyBudget,
  evaluateEnvironmentPolicy,
  normalizeActionClass,
} from "./evaluator.js";
export { PolicyLoadError, loadPolicyFile, parsePolicyConfig } from "./loader.js";
export type {
  AutonomyBudget,
  EnforcementMode,
  EnvironmentPolicy,
  PolicyCondition,
  PolicyConfig,
  PolicyInput,
  PolicyRule,
  PolicyVerdict,
  RulesOutcome,
} from "./types.js";
export { HIGH_RISK_THRESHOLD, riskAtLeast } from "./types.js";
