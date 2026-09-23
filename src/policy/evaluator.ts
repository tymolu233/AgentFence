/**
 * 策略求值器接口 + 内置结构化条件求值实现。
 * 接口抽象为 OPA/Rego 后置预留：Rego 求值器实现同一 PolicyEvaluator 接口即可替换；
 * 内置实现为闭集字段的结构化条件求值（DeepintShield 类型化 AST 思路）。
 */
import type { RiskLevel } from "../api/types.js";
import type {
  ConditionOperator,
  PolicyCondition,
  PolicyInput,
  PolicyRule,
  PolicyVerdict,
} from "./types.js";
import { riskAtLeast } from "./types.js";

/**
 * 求值器接口。输入为规范化 PolicyInput，输出首个命中规则的判定或 null。
 * 实现必须是进程内纯函数（不碰网络/文件/时钟）。
 */
export interface PolicyEvaluator {
  evaluate(input: PolicyInput, rules: readonly PolicyRule[]): PolicyVerdict | null;
}

/** 从输入提取条件字段的当前值；缺失字段返回 undefined（条件不命中，fail-safe） */
function fieldValue(
  input: PolicyInput,
  field: PolicyCondition["field"],
): string | undefined {
  switch (field) {
    case "agent":
      return input.call.agent_id;
    case "target":
      return input.call.context?.target;
    case "tool":
      return input.call.tool.name;
    case "action":
      return input.call.tool.action;
    case "environment":
      return input.call.context?.environment;
    case "risk":
      return input.rules?.risk;
  }
}

/** 单条件匹配；不可解析输入（缺字段、类型不符）一律不命中 */
function matches(condition: PolicyCondition, input: PolicyInput): boolean {
  const actual = fieldValue(input, condition.field);
  if (actual === undefined) return false;

  const operator: ConditionOperator = condition.operator;
  const expected = condition.value;

  switch (operator) {
    case "eq":
      return typeof expected === "string" && actual === expected;
    case "ne":
      return typeof expected === "string" && actual !== expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "not_in":
      return Array.isArray(expected) && !expected.includes(actual);
  }
}

/**
 * 内置结构化条件求值器。
 * 规则按 priority 升序（数字小者先判），首个全部条件命中的规则胜出。
 */
export class StructuredEvaluator implements PolicyEvaluator {
  evaluate(input: PolicyInput, rules: readonly PolicyRule[]): PolicyVerdict | null {
    const sorted = [...rules].sort((a, b) => a.priority - b.priority);
    for (const rule of sorted) {
      if (rule.conditions.every((c) => matches(c, input))) {
        return {
          verdict: rule.verdict,
          reason: rule.reason ?? `policy rule ${rule.id} matched`,
          policy_id: rule.id,
        };
      }
    }
    return null;
  }
}

/**
 * 环境策略简写求值：policy.<environment>.<action_class>。
 * 动作类别由工具 action 归一（未知 action 不命中，返回 null）。
 * 环境缺失或该环境无此条目时返回 null（由引擎走 fail-closed 兜底）。
 */
export function evaluateEnvironmentPolicy(
  input: PolicyInput,
  envPolicy: Partial<Record<string, Partial<Record<string, string>>>>,
  policyPrefix: string,
): PolicyVerdict | null {
  const environment = input.call.context?.environment;
  if (environment === undefined) return null;
  const table = envPolicy[environment];
  if (table === undefined) return null;

  const actionClass = normalizeActionClass(input.call.tool.action);
  if (actionClass === undefined) return null;

  const verdict = table[actionClass];
  if (verdict !== "ALLOW" && verdict !== "REVIEW" && verdict !== "DENY") return null;

  return {
    verdict,
    reason: `environment policy: ${environment}.${actionClass} = ${verdict.toLowerCase()}`,
    policy_id: `${policyPrefix}.${environment}.${actionClass}`,
  };
}

/** action → 动作类别归一；未知 action 返回 undefined */
export function normalizeActionClass(action: string): string | undefined {
  const table: Record<string, string> = {
    read: "read",
    query: "read",
    get: "read",
    list: "read",
    write: "write",
    modify: "write",
    execute: "write",
    delete: "destructive",
    destroy: "destructive",
    drop: "destructive",
    truncate: "destructive",
    destructive: "destructive",
    credential_access: "credential_access",
    read_credential: "credential_access",
    export_credential: "credential_access",
    exfiltrate: "network_exfiltration",
    network_exfiltration: "network_exfiltration",
    reverse_shell: "reverse_shell",
  };
  return table[action];
}

/** autonomy budget：高危风险把 ALLOW 降级为 REVIEW（只降级，永不升级） */
export function applyAutonomyBudget(
  verdict: PolicyVerdict,
  risk: RiskLevel | undefined,
  budget: { downgrade_allow_at: "HIGH" | "CRITICAL" } | undefined,
): PolicyVerdict {
  if (budget === undefined || risk === undefined) return verdict;
  if (verdict.verdict !== "ALLOW") return verdict;
  if (!riskAtLeast(risk, budget.downgrade_allow_at)) return verdict;
  return {
    ...verdict,
    verdict: "REVIEW",
    reason: `${verdict.reason}; autonomy budget: ALLOW downgraded to REVIEW at risk ${risk}`,
  };
}
