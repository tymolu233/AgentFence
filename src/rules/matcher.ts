/**
 * 规则 matcher：在 Parser 产出的 token 流（ParsedShell/ParsedCommand）上做
 * 结构化匹配，禁止对拼接后的原始命令字符串跑正则。
 *
 * 匹配原语（单条子命令维度，AND 语义，any 为 OR）：
 *   argv0 / argv0_regex / subcommand(glob) / flags / flags_any /
 *   args_regex（有界正则 + 长度截断）/ target_guarded（语义谓词）/
 *   destructive_find（语义谓词）/ stdin_from（跨子命令前缀近似谓词）。
 * 仲裁：显式 priority（小者先判）+ deny-overrides（多规则命中取最重，
 * DENY > REVIEW，同级 severity 大者定 risk）。
 */

import type {
  ParsedCommand,
  ParsedShell,
  RiskLevel,
  ToolCall,
} from "../api/types.js";
import {
  SEVERITY_TO_RISK,
  type FlagExpectation,
  type Rule,
  type RuleAction,
  type RuleMatch,
  type RuleSeverity,
} from "./schema.js";

/** 单条位置参数进入 args_regex 前的长度截断（ReDoS 防线，正则是兜底而非主力） */
const MAX_ARG_SCAN = 4096;

const REGEX_LITERAL = /^\/(.*)\/([a-z]*)$/;

/**
 * 归一化 flag 别名表（键值均已小写）。表刻意保持最小：
 * 别名只在 argv0+subcommand 已圈定命令后参与判定，误折叠面可控。
 * 注意 f 不入表（kubectl -f 是 filename，与 git 系 -f=force 冲突）。
 */
const FLAG_ALIASES: Record<string, string> = {
  r: "recursive",
  R: "recursive",
  recursive: "recursive",
  a: "all",
  all: "all",
};

/** 语义谓词 target_guarded 守卫的字面目标（trailing slash 归一后比较） */
const GUARDED_LITERALS = new Set(["/", ".", "..", "~", "$home", "${home}", "%userprofile%"]);

/** target_guarded 守卫的系统目录（路径前缀语义：目录本身及其子路径均命中） */
const GUARDED_SYSTEM_DIRS = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/var",
  "/boot",
  "/lib",
  "/lib64",
  "/opt",
];

/** 裸 glob（*、** 等纯通配）：作为删除目标时等价于当前目录整体 */
const BARE_GLOB = /^\*+$/;

/** Windows 盘符根（尾斜杠已归一）：C:\ / C:/ / c: */
const DRIVE_ROOT = /^[a-z]:$/;

/** Git Bash/MSYS 风格盘符根：/c /d ... */
const POSIX_DRIVE_ROOT = /^\/[a-z]$/;

export interface MatchedRule {
  id: string;
  action: RuleAction;
  severity: RuleSeverity;
  priority: number;
  commandIndex: number;
}

export interface RuleVerdict {
  /** 命中规则里最重的判定；deny-overrides */
  decision: "DENY" | "REVIEW";
  risk: RiskLevel;
  confidence: number;
  /** 按仲裁序（action 权重 → priority → id）排序的命中规则 id */
  matched_rules: string[];
  reason: string;
}

interface LexedArgs {
  /** 归一化 flag 表（去横线、小写、别名折叠）；append 语义聚合原值 */
  flags: Map<string, string | true>;
  positionals: string[];
}

function normalizeArgv0(executable: string): string {
  const base = executable.replaceAll("\\", "/").split("/").pop() ?? executable;
  return base.toLowerCase().replace(/\.(exe|bat|cmd|com)$/, "");
}

function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value.charAt(0);
    const last = value.charAt(value.length - 1);
    if ((first === '"' || first === "'") && last === first) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * 把 ParsedCommand.args 词法化为归一化 flag 表 + 位置参数。
 * - `--name` / `-name`（含连字符的单横线长 flag，terraform 风格）→ 长 flag
 * - `--name=value` / `-name=value` → 带值 flag（值去引号、小写）
 * - `-abc` → 逐字母短 flag
 * - `--` 之后全部归位置参数
 */
export function lexArgs(args: string[]): LexedArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let afterTerminator = false;

  const putFlag = (rawName: string, value: string | true): void => {
    const lowered = rawName.toLowerCase();
    const canonical = FLAG_ALIASES[rawName] ?? FLAG_ALIASES[lowered] ?? lowered;
    const normalized = typeof value === "string" ? stripSurroundingQuotes(value).toLowerCase() : value;
    const prev = flags.get(canonical);
    // 同一 flag 重复出现：true 不覆盖已记录的具体值，取首个具体值
    if (prev === undefined || (prev === true && normalized !== true)) {
      flags.set(canonical, normalized);
    }
  };

  for (const token of args) {
    if (afterTerminator) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      afterTerminator = true;
      continue;
    }
    if (token.startsWith("--") && token.length > 2) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) putFlag(body.slice(0, eq), body.slice(eq + 1));
      else putFlag(body, true);
      continue;
    }
    if (token.startsWith("-") && token.length > 1 && token !== "-") {
      const body = token.slice(1);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        putFlag(body.slice(0, eq), body.slice(eq + 1));
      } else if (body.includes("-")) {
        // -auto-approve / -force-reset：单横线长 flag
        putFlag(body, true);
      } else {
        for (const ch of body) putFlag(ch, true);
      }
      continue;
    }
    positionals.push(token);
  }
  return { flags, positionals };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${source}$`, "i");
}

/** loader 已保证字面量合法；这里只做编译（结果可缓存于模块级 Map） */
const regexCache = new Map<string, RegExp>();

function compileLiteral(literal: string): RegExp {
  const cached = regexCache.get(literal);
  if (cached) return cached;
  const parsed = REGEX_LITERAL.exec(literal);
  if (!parsed || parsed[1] === undefined) {
    throw new Error(`非法正则字面量（loader 应已拦截）：${literal}`);
  }
  const re = new RegExp(parsed[1], parsed[2]);
  regexCache.set(literal, re);
  return re;
}

function matchFlagExpectation(actual: string | true | undefined, expect: FlagExpectation): boolean {
  if (actual === undefined) return false;
  if (expect === true || expect === "*") return true;
  return actual === expect.toLowerCase();
}

function matchFlags(
  table: Record<string, FlagExpectation>,
  flags: ReadonlyMap<string, string | true>,
): boolean {
  return Object.entries(table).every(([name, expect]) =>
    matchFlagExpectation(flags.get(name.toLowerCase()), expect),
  );
}

function matchFlagsAny(
  table: Record<string, FlagExpectation>,
  flags: ReadonlyMap<string, string | true>,
): boolean {
  return Object.entries(table).some(([name, expect]) =>
    matchFlagExpectation(flags.get(name.toLowerCase()), expect),
  );
}

function matchSubcommand(sequence: string[], positionals: string[]): boolean {
  if (sequence.length > positionals.length) return false;
  return sequence.every((item, i) => globToRegExp(item).test(positionals[i] ?? ""));
}

function matchArgsRegex(literals: string[], positionals: string[]): boolean {
  for (const arg of positionals) {
    const haystack = arg.length > MAX_ARG_SCAN ? arg.slice(0, MAX_ARG_SCAN) : arg;
    if (literals.some((lit) => compileLiteral(lit).test(haystack))) return true;
  }
  return false;
}

/** target_guarded 语义谓词：位置参数中出现守卫目标 */
export function isGuardedTarget(raw: string): boolean {
  const unquoted = stripSurroundingQuotes(raw).replaceAll("\\", "/");
  // 归一化：合并重复斜杠、去尾部斜杠与尾部通配（"/*"、"~/*"）
  let token = unquoted.replace(/\/{2,}/g, "/");
  while (token.length > 1) {
    const stripped = token.replace(/(\/\*+|\/+)$/, "");
    if (stripped === token) break;
    token = stripped === "" ? "/" : stripped;
  }
  const lower = token.toLowerCase();
  if (GUARDED_LITERALS.has(lower)) return true;
  // 裸 * glob（含 ./*，后者归一到 "." 已在字面表内命中）
  if (BARE_GLOB.test(token)) return true;
  // Windows / MSYS 盘符根
  if (DRIVE_ROOT.test(lower) || POSIX_DRIVE_ROOT.test(lower)) return true;
  // 系统目录：前缀语义（"/etcx" 不命中，"/etc" 与 "/etc/nginx" 命中）
  return GUARDED_SYSTEM_DIRS.some((dir) => lower === dir || lower.startsWith(`${dir}/`));
}

/**
 * destructive_find 语义谓词：find 的删除语义（-delete，或 -exec/-execdir 直调 rm），
 * 与 rm -rf 同效。作用于未词法化的原始 argv——`-delete` 这类 find 单横线谓词
 * 进入 lexArgs 会被逐字母拆成短 flag，词法化后的表象无法表达该语义。
 */
function isDestructiveFind(argv0: string, args: readonly string[]): boolean {
  if (argv0 !== "find") return false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "-delete") return true;
    if (
      (token === "-exec" || token === "-execdir") &&
      normalizeArgv0(args[i + 1] ?? "") === "rm"
    ) {
      return true;
    }
  }
  return false;
}

function commandMatches(
  match: RuleMatch,
  argv0: string,
  lexed: LexedArgs,
  rawArgs: readonly string[],
): boolean {
  if (match.argv0 !== undefined && !match.argv0.includes(argv0)) return false;
  if (match.argv0_regex !== undefined && !compileLiteral(match.argv0_regex).test(argv0)) {
    return false;
  }
  if (match.subcommand !== undefined && !matchSubcommand(match.subcommand, lexed.positionals)) {
    return false;
  }
  if (match.flags !== undefined && !matchFlags(match.flags, lexed.flags)) return false;
  if (match.flags_any !== undefined && !matchFlagsAny(match.flags_any, lexed.flags)) {
    return false;
  }
  if (match.args_regex !== undefined && !matchArgsRegex(match.args_regex, lexed.positionals)) {
    return false;
  }
  if (match.target_guarded === true && !lexed.positionals.some(isGuardedTarget)) {
    return false;
  }
  if (match.destructive_find === true && !isDestructiveFind(argv0, rawArgs)) {
    return false;
  }
  if (match.any !== undefined) {
    return match.any.some((sub) => commandMatches(sub, argv0, lexed, rawArgs));
  }
  return true;
}

/**
 * stdin_from 跨子命令谓词：近似表达"shell 的 stdin 来自 curl/wget 的输出"。
 * ParsedShell 只保留子命令顺序、不保留管道连接关系，故语义取前缀近似：
 * 命中子命令必须是不带任何 argv 的裸解释器（载荷经 stdin 喂入、argv 不可见），
 * 且同条输入中存在更早的子命令其 argv0 属于 stdin_from 列表。
 * （注意与 `wget x.sh && bash x.sh` 区分：后者 argv 可见、载荷在盘上，不命中。）
 */
function matchStdinFrom(
  sources: readonly string[] | undefined,
  commands: readonly ParsedCommand[],
  index: number,
): boolean {
  if (sources === undefined) return true;
  const candidate = commands[index];
  if (candidate === undefined || candidate.args.length > 0) return false;
  const wanted = new Set(sources.map((s) => s.toLowerCase()));
  for (let j = 0; j < index; j += 1) {
    const upstream = commands[j];
    if (upstream !== undefined && wanted.has(normalizeArgv0(upstream.executable))) {
      return true;
    }
  }
  return false;
}

function matchToolField(tool: string | string[] | undefined, call: ToolCall): boolean {
  if (tool === undefined) return true;
  const candidates = new Set(
    [call.tool.name, call.tool.category ?? ""].map((s) => s.toLowerCase()),
  );
  const wanted = Array.isArray(tool) ? tool : [tool];
  return wanted.some((name) => candidates.has(name.toLowerCase()));
}

/**
 * 单条规则对单个子命令的判定（不含 tool 字段路由，路由在 call 层做）。
 * stdin_from 在孤立单命令视角下无从满足（没有更早的上游子命令）。
 */
export function matchRuleAgainstCommand(rule: Rule, cmd: ParsedCommand): boolean {
  return (
    commandMatches(rule.match, normalizeArgv0(cmd.executable), lexArgs(cmd.args), cmd.args) &&
    matchStdinFrom(rule.match.stdin_from, [cmd], 0)
  );
}

function hasCommandClauses(match: RuleMatch): boolean {
  return (
    match.argv0 !== undefined ||
    match.argv0_regex !== undefined ||
    match.subcommand !== undefined ||
    match.flags !== undefined ||
    match.flags_any !== undefined ||
    match.args_regex !== undefined ||
    match.target_guarded === true ||
    match.destructive_find === true ||
    match.stdin_from !== undefined ||
    match.any !== undefined
  );
}

/** 单条规则对整条 ToolCall（含全部子命令）的判定；返回命中的子命令序号 */
export function matchRuleAgainstCall(
  rule: Rule,
  call: ToolCall,
  parsed?: ParsedShell,
): number | null {
  if (!matchToolField(rule.match.tool, call)) return null;
  if (!hasCommandClauses(rule.match)) return 0; // 纯 tool 路由规则（如 credentials 类目）
  const commands = parsed?.commands ?? [];
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    if (
      cmd &&
      commandMatches(rule.match, normalizeArgv0(cmd.executable), lexArgs(cmd.args), cmd.args) &&
      matchStdinFrom(rule.match.stdin_from, commands, i)
    ) {
      return i;
    }
  }
  return null;
}

const ACTION_RANK: Record<RuleAction, number> = { DENY: 2, REVIEW: 1 };
const SEVERITY_RANK: Record<RuleSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * 仲裁：遍历全部规则收集命中（每条规则记录最早命中的子命令），
 * 多规则命中取最重——DENY > REVIEW；risk 取命中规则最高 severity。
 * 无命中返回 undefined（"无命中即 ALLOW" 的默认语义由上层装配）。
 */
export function evaluateToolCall(
  rules: readonly Rule[],
  call: ToolCall,
  parsed?: ParsedShell,
): RuleVerdict | undefined {
  const matched: MatchedRule[] = [];
  for (const rule of rules) {
    const commandIndex = matchRuleAgainstCall(rule, call, parsed);
    if (commandIndex !== null) {
      matched.push({
        id: rule.id,
        action: rule.action,
        severity: rule.severity,
        priority: rule.priority,
        commandIndex,
      });
    }
  }
  if (matched.length === 0) return undefined;

  matched.sort(
    (a, b) =>
      ACTION_RANK[b.action] - ACTION_RANK[a.action] ||
      a.priority - b.priority ||
      a.id.localeCompare(b.id),
  );
  const top = matched[0];
  if (!top) return undefined;

  // risk = 全部命中中的最高 severity（不论 action）
  let maxSeverity: RuleSeverity = top.severity;
  for (const hit of matched) {
    if (SEVERITY_RANK[hit.severity] > SEVERITY_RANK[maxSeverity]) {
      maxSeverity = hit.severity;
    }
  }
  const risk = SEVERITY_TO_RISK[maxSeverity];

  return {
    decision: top.action,
    risk,
    confidence: 1,
    matched_rules: matched.map((hit) => hit.id),
    reason: `命中规则 ${top.id}（${top.action}/${top.severity}，共 ${matched.length} 条命中）`,
  };
}
