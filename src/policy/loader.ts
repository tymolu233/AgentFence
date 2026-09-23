/**
 * 策略配置加载器。校验失败一律抛 PolicyLoadError（fail-closed：
 * 坏配置不得静默降级为宽松策略）。
 * parsePolicyConfig 是纯函数；loadPolicyFile 是唯一的 IO 薄适配。
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type {
  ActionClass,
  AutonomyBudget,
  ConditionField,
  ConditionOperator,
  DecisionKind,
  EnforcementMode,
  Environment,
  EnvironmentPolicy,
  PolicyCondition,
  PolicyRule,
} from "./types.js";
import {
  ACTION_CLASSES,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  ENVIRONMENTS,
} from "./types.js";
import type { PolicyConfig } from "./types.js";

export class PolicyLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyLoadError";
  }
}

const DECISION_KINDS = ["ALLOW", "REVIEW", "DENY"] as const;
const ENFORCEMENT_MODES = ["enforce", "shadow"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new PolicyLoadError(`${path}: ${message}`);
}

function asClosedSet<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  options?: { normalizeUpper?: boolean },
): T {
  if (typeof value !== "string") fail(path, `expected string, got ${typeof value}`);
  const normalized = options?.normalizeUpper === true ? value.toUpperCase() : value;
  const hit = allowed.find((candidate) => candidate === normalized);
  if (hit === undefined) {
    fail(path, `unknown value ${JSON.stringify(value)}; allowed: ${allowed.join(", ")}`);
  }
  return hit;
}

function parseVerdict(value: unknown, path: string): DecisionKind {
  return asClosedSet(value, DECISION_KINDS, path, { normalizeUpper: true });
}

function parseCondition(value: unknown, path: string): PolicyCondition {
  if (!isRecord(value)) fail(path, "condition must be a mapping");
  const field = asClosedSet<ConditionField>(value.field, CONDITION_FIELDS, `${path}.field`);
  const operator = asClosedSet<ConditionOperator>(
    value.operator,
    CONDITION_OPERATORS,
    `${path}.operator`,
  );
  const raw = value.value;
  if (operator === "eq" || operator === "ne") {
    if (typeof raw !== "string") fail(`${path}.value`, `${operator} expects a string`);
    return { field, operator, value: raw };
  }
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
    fail(`${path}.value`, `${operator} expects a string array`);
  }
  return { field, operator, value: raw };
}

function parseRule(value: unknown, index: number): PolicyRule {
  const path = `rules[${String(index)}]`;
  if (!isRecord(value)) fail(path, "rule must be a mapping");
  if (typeof value.id !== "string" || value.id === "") fail(`${path}.id`, "expected non-empty string");
  if (typeof value.priority !== "number" || !Number.isFinite(value.priority)) {
    fail(`${path}.priority`, "expected finite number");
  }
  const verdict = parseVerdict(value.verdict, `${path}.verdict`);
  if (!Array.isArray(value.conditions)) fail(`${path}.conditions`, "expected array");
  const conditions = value.conditions.map((c, i) =>
    parseCondition(c, `${path}.conditions[${String(i)}]`),
  );
  const reason = value.reason;
  if (reason !== undefined && typeof reason !== "string") {
    fail(`${path}.reason`, "expected string");
  }
  return {
    id: value.id,
    priority: value.priority,
    verdict,
    conditions,
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

function parseEnvironmentPolicy(value: unknown, path: string): EnvironmentPolicy {
  if (!isRecord(value)) fail(path, "environment policy must be a mapping");
  const table: Record<string, DecisionKind> = {};
  for (const [key, raw] of Object.entries(value)) {
    const actionClass = asClosedSet<ActionClass>(key, ACTION_CLASSES, `${path}.${key}`);
    table[actionClass] = parseVerdict(raw, `${path}.${key}`);
  }
  return table;
}

function parseAutonomyBudget(value: unknown): AutonomyBudget {
  if (!isRecord(value)) fail("autonomy_budget", "expected mapping");
  const at = value.downgrade_allow_at;
  if (at !== "HIGH" && at !== "CRITICAL") {
    fail("autonomy_budget.downgrade_allow_at", "expected HIGH or CRITICAL");
  }
  return { downgrade_allow_at: at };
}

/** 解析并校验策略配置文本；任何形状/闭集错误都抛 PolicyLoadError */
export function parsePolicyConfig(yamlText: string): PolicyConfig {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch (error) {
    throw new PolicyLoadError(
      `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(doc)) fail("(root)", "policy document must be a mapping");

  if (doc.version !== 1) fail("version", "expected 1");
  if (doc.mode !== "fail_closed") fail("mode", 'expected "fail_closed"');

  const enforcement: EnforcementMode =
    doc.enforcement === undefined
      ? "enforce"
      : asClosedSet(doc.enforcement, ENFORCEMENT_MODES, "enforcement");

  const policy: Partial<Record<Environment, EnvironmentPolicy>> = {};
  if (doc.policy !== undefined) {
    if (!isRecord(doc.policy)) fail("policy", "expected mapping");
    for (const [key, raw] of Object.entries(doc.policy)) {
      const env = asClosedSet<Environment>(key, ENVIRONMENTS, `policy.${key}`);
      policy[env] = parseEnvironmentPolicy(raw, `policy.${key}`);
    }
  }

  const rules: PolicyRule[] = [];
  if (doc.rules !== undefined) {
    if (!Array.isArray(doc.rules)) fail("rules", "expected array");
    doc.rules.forEach((raw, i) => rules.push(parseRule(raw, i)));
  }

  const autonomy_budget =
    doc.autonomy_budget === undefined ? undefined : parseAutonomyBudget(doc.autonomy_budget);

  let allowed_tools: string[] | undefined;
  if (doc.allowed_tools !== undefined) {
    if (!Array.isArray(doc.allowed_tools) || !doc.allowed_tools.every((t) => typeof t === "string")) {
      fail("allowed_tools", "expected string array");
    }
    allowed_tools = doc.allowed_tools;
  }

  return {
    version: 1,
    mode: "fail_closed",
    enforcement,
    policy,
    rules,
    ...(autonomy_budget !== undefined ? { autonomy_budget } : {}),
    ...(allowed_tools !== undefined ? { allowed_tools } : {}),
  };
}

/** IO 薄适配：读文件后交纯函数解析 */
export function loadPolicyFile(path: string): PolicyConfig {
  return parsePolicyConfig(readFileSync(path, "utf8"));
}
