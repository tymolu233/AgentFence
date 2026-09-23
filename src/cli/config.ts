/**
 * CLI 配置加载：agentfence.yaml（--config 可指定路径）。
 *
 * 配置形状（全部可选，缺省用内置默认）：
 *
 *   rules_dir: rules                    # 规则目录
 *   policy_file: policies/default.yaml  # 策略文件
 *   audit:
 *     path: .agentfence/audit.jsonl     # 审计落盘目标
 *     mode: best_effort                 # best_effort | durable | fail_closed
 *   judge:
 *     enabled: false                    # v0.1 无内置评分器；开启后灰区 fail-closed
 *   acl:                                # 透传给 engine 的 ACL 配置
 *     default: { allow: [shell] }
 *     agents: { research: { tools: { shell: { allowed: false } } } }
 *
 * 相对路径一律相对配置文件所在目录解析；无配置文件时相对 cwd。
 * 校验失败（未知字段、非法闭集值）抛 ConfigError —— fail-closed，
 * 坏配置不得静默降级。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { BackpressureMode } from "../audit/index.js";
import type { AclConfig, AgentAcl } from "../engine/index.js";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export interface CliConfig {
  rulesDir: string;
  policyFile: string;
  auditPath: string;
  auditMode: BackpressureMode;
  judgeEnabled: boolean;
  acl?: AclConfig;
}

const BACKPRESSURE_MODES: readonly BackpressureMode[] = [
  "best_effort",
  "durable",
  "fail_closed",
];

const KNOWN_TOP_KEYS = new Set(["rules_dir", "policy_file", "audit", "judge", "acl"]);
const KNOWN_AUDIT_KEYS = new Set(["path", "mode"]);
const KNOWN_JUDGE_KEYS = new Set(["enabled"]);
const KNOWN_ACL_KEYS = new Set(["agents", "default"]);
const KNOWN_AGENT_ACL_KEYS = new Set(["deny", "allow", "tools"]);

function fail(where: string, message: string): never {
  throw new ConfigError(`${where}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  known: ReadonlySet<string>,
  where: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) fail(where, `未知字段 "${key}"（fail-closed）`);
  }
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) fail(where, "必须是非空字符串");
  return value;
}

function asStringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail(where, "必须是字符串数组");
  }
  return value;
}

function parseAgentAcl(value: unknown, where: string): AgentAcl {
  if (!isRecord(value)) fail(where, "必须是对象");
  rejectUnknownKeys(value, KNOWN_AGENT_ACL_KEYS, where);
  const entry: AgentAcl = {};
  if (value.deny !== undefined) entry.deny = asStringList(value.deny, `${where}.deny`);
  if (value.allow !== undefined) entry.allow = asStringList(value.allow, `${where}.allow`);
  if (value.tools !== undefined) {
    if (!isRecord(value.tools)) fail(`${where}.tools`, "必须是对象");
    const tools: Record<string, { allowed: boolean }> = {};
    for (const [tool, gate] of Object.entries(value.tools)) {
      if (!isRecord(gate) || typeof gate.allowed !== "boolean") {
        fail(`${where}.tools.${tool}`, '必须是 { allowed: boolean }');
      }
      tools[tool] = { allowed: gate.allowed };
    }
    entry.tools = tools;
  }
  return entry;
}

function parseAcl(value: unknown, where: string): AclConfig {
  if (!isRecord(value)) fail(where, "必须是对象");
  rejectUnknownKeys(value, KNOWN_ACL_KEYS, where);
  const acl: AclConfig = {};
  if (value.default !== undefined) {
    acl.default = parseAgentAcl(value.default, `${where}.default`);
  }
  if (value.agents !== undefined) {
    if (!isRecord(value.agents)) fail(`${where}.agents`, "必须是对象");
    const agents: Record<string, AgentAcl> = {};
    for (const [agentId, entry] of Object.entries(value.agents)) {
      agents[agentId] = parseAgentAcl(entry, `${where}.agents.${agentId}`);
    }
    acl.agents = agents;
  }
  return acl;
}

/** 内置默认：cwd 下的 rules/ + policies/default.yaml + .agentfence/audit.jsonl */
function defaults(baseDir: string): CliConfig {
  return {
    rulesDir: path.join(baseDir, "rules"),
    policyFile: path.join(baseDir, "policies", "default.yaml"),
    auditPath: path.join(baseDir, ".agentfence", "audit.jsonl"),
    auditMode: "best_effort",
    judgeEnabled: false,
  };
}

/**
 * 加载 CLI 配置。
 * - configPath 显式给出：文件必须存在且合法，否则 ConfigError；
 * - 未给出：cwd 下存在 agentfence.yaml 则用之，否则用内置默认。
 */
export function loadCliConfig(
  configPath: string | undefined,
  cwd: string = process.cwd(),
): CliConfig {
  const discovered = configPath ?? path.join(cwd, "agentfence.yaml");
  if (configPath === undefined && !existsSync(discovered)) {
    return defaults(cwd);
  }
  if (!existsSync(discovered)) {
    throw new ConfigError(`配置文件不存在：${discovered}`);
  }

  const text = readFileSync(discovered, "utf8");
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (error) {
    throw new ConfigError(
      `配置 YAML 解析失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (doc === null || doc === undefined) return defaults(path.dirname(discovered));
  if (!isRecord(doc)) fail("(root)", "配置必须是对象");
  rejectUnknownKeys(doc, KNOWN_TOP_KEYS, "(root)");

  const baseDir = path.dirname(discovered);
  const config = defaults(baseDir);

  if (doc.rules_dir !== undefined) {
    config.rulesDir = path.resolve(baseDir, asString(doc.rules_dir, "rules_dir"));
  }
  if (doc.policy_file !== undefined) {
    config.policyFile = path.resolve(baseDir, asString(doc.policy_file, "policy_file"));
  }
  if (doc.audit !== undefined) {
    if (!isRecord(doc.audit)) fail("audit", "必须是对象");
    rejectUnknownKeys(doc.audit, KNOWN_AUDIT_KEYS, "audit");
    if (doc.audit.path !== undefined) {
      config.auditPath = path.resolve(baseDir, asString(doc.audit.path, "audit.path"));
    }
    if (doc.audit.mode !== undefined) {
      const mode = asString(doc.audit.mode, "audit.mode");
      if (!BACKPRESSURE_MODES.includes(mode as BackpressureMode)) {
        fail("audit.mode", `非法闭集值 "${mode}"，允许：${BACKPRESSURE_MODES.join(" / ")}`);
      }
      config.auditMode = mode as BackpressureMode;
    }
  }
  if (doc.judge !== undefined) {
    if (!isRecord(doc.judge)) fail("judge", "必须是对象");
    rejectUnknownKeys(doc.judge, KNOWN_JUDGE_KEYS, "judge");
    if (doc.judge.enabled !== undefined) {
      if (typeof doc.judge.enabled !== "boolean") fail("judge.enabled", "必须是布尔值");
      config.judgeEnabled = doc.judge.enabled;
    }
  }
  if (doc.acl !== undefined) {
    config.acl = parseAcl(doc.acl, "acl");
  }
  return config;
}
