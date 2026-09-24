/**
 * YAML 规则加载器：读取 rules/*.yaml，逐字段校验（fail-closed），
 * 任何非法规则都让加载整体失败，不静默跳过。
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import {
  RULE_ACTIONS,
  RULE_CATEGORIES,
  RULE_SEVERITIES,
  type FlagExpectation,
  type Rule,
  type RuleCategory,
  type RuleMatch,
  type RuleSeverity,
  type RuleTests,
} from "./schema.js";

export class RuleLoadError extends Error {
  override readonly name = "RuleLoadError";
}

const KNOWN_RULE_KEYS = new Set([
  "id",
  "category",
  "severity",
  "action",
  "priority",
  "match",
  "refs",
  "tests",
]);

const KNOWN_MATCH_KEYS = new Set([
  "tool",
  "argv0",
  "argv0_regex",
  "subcommand",
  "flags",
  "flags_any",
  "args_regex",
  "target_guarded",
  "destructive_find",
  "stdin_from",
  "any",
]);

const KNOWN_TESTS_KEYS = new Set(["deny", "allow"]);

/** 正则字面量总长上限（规则格式自我约束的 ReDoS 防线） */
const MAX_REGEX_SOURCE = 200;

const REGEX_LITERAL = /^\/(.*)\/([a-z]*)$/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function fail(where: string, message: string): never {
  throw new RuleLoadError(`${where}: ${message}`);
}

function isRecord(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: Json | undefined, where: string): JsonObject {
  if (!isRecord(value)) fail(where, "必须是对象");
  return value;
}

function requireString(value: Json | undefined, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(where, "必须是非空字符串");
  }
  return value;
}

function requireStringList(value: Json | undefined, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(where, "必须是非空字符串数组");
  }
  return value.map((item, i) => requireString(item, `${where}[${i}]`));
}

function requireClosedSet<T extends string>(
  value: Json | undefined,
  allowed: readonly T[],
  where: string,
): T {
  const parsed = requireString(value, where);
  if (!(allowed as readonly string[]).includes(parsed)) {
    fail(where, `非法闭集值 "${parsed}"，允许：${allowed.join(" / ")}`);
  }
  return parsed as T;
}

function rejectUnknownKeys(
  obj: JsonObject,
  known: ReadonlySet<string>,
  where: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) fail(where, `未知字段 "${key}"（fail-closed）`);
  }
}

/** 解析 `/pattern/flags` 字面量并预编译，保证 invalid regex 在加载期爆炸 */
function parseRegexLiteral(raw: string, where: string): string {
  if (raw.length > MAX_REGEX_SOURCE) {
    fail(where, `正则字面量超长（>${MAX_REGEX_SOURCE} 字符）`);
  }
  const literal = REGEX_LITERAL.exec(raw);
  if (!literal || literal[1] === undefined) {
    fail(where, `正则必须是 /pattern/flags 字面量：${JSON.stringify(raw)}`);
  }
  const flags = literal[2] ?? "";
  for (const f of flags) {
    if (f !== "i" && f !== "s") {
      fail(where, `正则 flag 仅允许 i/s：${JSON.stringify(raw)}`);
    }
  }
  try {
    new RegExp(literal[1], flags);
  } catch (error) {
    fail(where, `正则无法编译：${error instanceof Error ? error.message : String(error)}`);
  }
  return raw;
}

function parseFlagTable(
  value: Json | undefined,
  where: string,
): Record<string, FlagExpectation> | undefined {
  if (value === undefined) return undefined;
  const obj = requireRecord(value, where);
  if (Object.keys(obj).length === 0) fail(where, "flag 表不能为空");
  const out: Record<string, FlagExpectation> = {};
  for (const [name, expect] of Object.entries(obj)) {
    if (expect === true || typeof expect === "string") {
      out[name] = expect;
    } else {
      fail(`${where}.${name}`, "flag 期望值只能是 true 或字符串");
    }
  }
  return out;
}

function parseMatch(value: Json | undefined, where: string, depth: number): RuleMatch {
  const obj = requireRecord(value, where);
  rejectUnknownKeys(obj, KNOWN_MATCH_KEYS, where);

  const match: RuleMatch = {};

  if (obj.tool !== undefined) {
    if (Array.isArray(obj.tool)) {
      match.tool = requireStringList(obj.tool, `${where}.tool`);
    } else {
      match.tool = requireString(obj.tool, `${where}.tool`);
    }
  }
  if (obj.argv0 !== undefined) {
    match.argv0 = requireStringList(obj.argv0, `${where}.argv0`);
  }
  if (obj.argv0_regex !== undefined) {
    match.argv0_regex = parseRegexLiteral(
      requireString(obj.argv0_regex, `${where}.argv0_regex`),
      `${where}.argv0_regex`,
    );
  }
  if (obj.subcommand !== undefined) {
    match.subcommand = requireStringList(obj.subcommand, `${where}.subcommand`);
  }
  match.flags = parseFlagTable(obj.flags, `${where}.flags`);
  match.flags_any = parseFlagTable(obj.flags_any, `${where}.flags_any`);
  if (obj.args_regex !== undefined) {
    const items = requireStringList(obj.args_regex, `${where}.args_regex`);
    match.args_regex = items.map((raw, i) =>
      parseRegexLiteral(raw, `${where}.args_regex[${i}]`),
    );
  }
  if (obj.target_guarded !== undefined) {
    if (typeof obj.target_guarded !== "boolean") {
      fail(`${where}.target_guarded`, "必须是布尔值");
    }
    match.target_guarded = obj.target_guarded;
  }
  if (obj.destructive_find !== undefined) {
    if (typeof obj.destructive_find !== "boolean") {
      fail(`${where}.destructive_find`, "必须是布尔值");
    }
    match.destructive_find = obj.destructive_find;
  }
  if (obj.stdin_from !== undefined) {
    match.stdin_from = requireStringList(obj.stdin_from, `${where}.stdin_from`);
  }
  if (obj.any !== undefined) {
    if (depth > 0) fail(`${where}.any`, "any 不允许嵌套");
    if (!Array.isArray(obj.any) || obj.any.length === 0) {
      fail(`${where}.any`, "必须是非空 match 对象数组");
    }
    match.any = obj.any.map((item, i) => parseMatch(item, `${where}.any[${i}]`, depth + 1));
  }

  const hasClause =
    match.tool !== undefined ||
    match.argv0 !== undefined ||
    match.argv0_regex !== undefined ||
    match.subcommand !== undefined ||
    (match.flags !== undefined && Object.keys(match.flags).length > 0) ||
    (match.flags_any !== undefined && Object.keys(match.flags_any).length > 0) ||
    (match.args_regex !== undefined && match.args_regex.length > 0) ||
    match.target_guarded === true ||
    match.destructive_find === true ||
    (match.stdin_from !== undefined && match.stdin_from.length > 0) ||
    (match.any !== undefined && match.any.length > 0);
  if (!hasClause) fail(where, "match 至少要有一个匹配子句");

  return match;
}

function parseTests(value: Json | undefined, where: string): RuleTests {
  const obj = requireRecord(value, where);
  rejectUnknownKeys(obj, KNOWN_TESTS_KEYS, where);
  return {
    deny: obj.deny === undefined ? [] : requireStringList(obj.deny, `${where}.deny`),
    allow: obj.allow === undefined ? [] : requireStringList(obj.allow, `${where}.allow`),
  };
}

function parseRule(
  value: Json | undefined,
  where: string,
  seenIds: ReadonlySet<string>,
  sourceFile: string,
): Rule {
  const obj = requireRecord(value, where);
  rejectUnknownKeys(obj, KNOWN_RULE_KEYS, where);

  const id = requireString(obj.id, `${where}.id`);
  if (seenIds.has(id)) fail(where, `重复的规则 id "${id}"`);

  const category: RuleCategory = requireClosedSet(obj.category, RULE_CATEGORIES, `${where}.category`);
  const severity: RuleSeverity = requireClosedSet(obj.severity, RULE_SEVERITIES, `${where}.severity`);
  const action = requireClosedSet(obj.action, RULE_ACTIONS, `${where}.action`);

  if (
    typeof obj.priority !== "number" ||
    !Number.isInteger(obj.priority) ||
    obj.priority < 0
  ) {
    fail(`${where}.priority`, "必须是非负整数");
  }
  const priority = obj.priority;

  return {
    id,
    category,
    severity,
    action,
    priority,
    match: parseMatch(obj.match, `${where}.match`, 0),
    refs: requireStringList(obj.refs, `${where}.refs`),
    tests: parseTests(obj.tests, `${where}.tests`),
    source_file: sourceFile,
  };
}

/** 注意：depth 限制只防 YAML anchor 循环；普通深度靠 YAML 库的 maxAliasCount */
const MAX_DOC_DEPTH = 32;

function toJson(value: unknown, where: string, depth: number): Json {
  if (depth > MAX_DOC_DEPTH) fail(where, "文档嵌套过深");
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return value;
    case "object": {
      if (Array.isArray(value)) {
        const arr: unknown[] = value;
        return arr.map((item, i) => toJson(item, `${where}[${i}]`, depth + 1));
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) {
        fail(where, "只允许纯对象/数组/标量（拒绝 YAMLTag/类实例）");
      }
      const rec = value as Record<string, unknown>;
      const out: JsonObject = {};
      for (const [k, v] of Object.entries(rec)) {
        out[k] = toJson(v, `${where}.${k}`, depth + 1);
      }
      return out;
    }
    default:
      fail(where, "不允许的标量类型");
  }
}

function idHint(item: Json): string {
  if (isRecord(item) && typeof item.id === "string") return item.id;
  return "?";
}

function parseRuleArray(json: Json, where: string, sourceFile: string, seenIds: Set<string>): Rule[] {
  if (!Array.isArray(json)) fail(where, "顶级必须是规则数组");
  if (json.length === 0) fail(where, "顶级规则数组不能为空");
  return json.map((item, i) => {
    const rule = parseRule(item, `${where}[${i}]（id ${idHint(item)}）`, seenIds, sourceFile);
    seenIds.add(rule.id);
    return rule;
  });
}

/** 解析单个规则文件（顶级为规则数组） */
export function parseRuleFile(
  text: string,
  sourceFile: string,
  seenIds: Set<string> = new Set(),
): Rule[] {
  const doc = parseDocument(text, {
    uniqueKeys: true,
    strict: true,
    logLevel: "silent",
  });
  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    throw new RuleLoadError(
      `${sourceFile}: YAML 解析失败：${first ? first.message : "unknown error"}`,
    );
  }
  const raw: unknown = doc.toJS({ maxAliasCount: 100 });
  const json = toJson(raw, sourceFile, 0);
  return parseRuleArray(json, sourceFile, sourceFile, seenIds);
}

/** 加载目录下全部 *.yaml 规则，按 (priority 升序, id) 排序返回 */
export function loadRules(dir: string): Rule[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    throw new RuleLoadError(
      `无法读取规则目录 ${dir}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const files = entries
    .filter((name) => name.endsWith(".yaml"))
    .sort((a, b) => a.localeCompare(b));
  if (files.length === 0) {
    throw new RuleLoadError(`规则目录 ${dir} 下没有 *.yaml 规则文件`);
  }

  const seenIds = new Set<string>();
  const rules: Rule[] = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const text = readFileSync(full, "utf8");
    rules.push(...parseRuleFile(text, file, seenIds));
  }
  rules.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  return rules;
}
