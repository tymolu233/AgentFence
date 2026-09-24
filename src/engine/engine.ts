/**
 * Engine 编排层：把五个模块编排成判定管线（architecture.md "检查管线"一节）。
 *
 * 层序与短路语义（便宜的确定性检查在前，任一前置层出结论即短路）：
 *
 *   1. ACL     按 agent_id 查 AclConfig；命中黑名单 / 工具开关 allowed:false /
 *              不在白名单 → DENY（decision_layer: "acl"）。语义见 types.ts。
 *   2. Parser  shell 类工具（tool.name 或 tool.category 为 "shell"）对
 *              input.command 调 parseShellCommand；ok:false 或 command 不是
 *              字符串 → DENY（fail-closed，decision_layer: "parser"）。
 *   3. Rules   evaluateToolCall 命中 DENY/REVIEW → 短路
 *              （decision_layer: "rules"，matched_rules 带命中 id）。
 *   4. Policy  policy.decide 返回 DENY/REVIEW → 短路（decision_layer: "policy"）；
 *              返回 ALLOW 是确定结论 → ALLOW 落定，不再进 judge；
 *              返回 null = 策略无意见 → 继续向下。
 *   5. indirect 启发式兜底（parser 及格线第 3 条）：任一子命令带 parser 的
 *              indirect 标记且前面各层无结论 → REVIEW（risk HIGH，
 *              confidence 0.8，decision_layer: "rules"，matched_rules 固定
 *              ["meta.indirect-execution"] 以便审计区分于具体类目规则）。
 *              明确规则 DENY/REVIEW 与 policy 结论优先，不被启发式抢走。
 *   6. Judge   仅 enabled:true 且前面无结论时调用 assess + decide；
 *              调用失败/超时/未接线 → 按 fail_closed（默认 true → DENY）。
 *              默认配置 judge 关闭，灰区落到第 7 步。
 *   7. 默认    rules 无命中、policy 无意见、无 indirect 迹象、judge 未启用 → ALLOW
 *              （"无命中即 ALLOW" 是规则层的既定默认语义）。
 *   8. Audit   每次判定（含 ALLOW）经 buildAuditRecord 写入 AuditQueue；
 *              fail_closed 背压由 applyAuditBackpressure 把非 DENY 改写为 DENY。
 *
 * 每层耗时累加进 Decision.latency_ms。判定逻辑是进程内纯函数组合，
 * 副作用只有审计入队与 session 读写（不变量 1/5/6）。
 *
 * Session（D4，配置 sessionStore 后启用）：
 *   入口   带 session_id 的调用注入 store.snapshot() 覆盖调用方自报的
 *          call.session（不变量 3：运行时状态由网关侧维护）；
 *   收尾   判定落定后（含背压改写后的有效判定）回写 tool+decision；
 *   降级   store 读/写失败不阻断管线：注入失败则剥离自报字段按无上下文
 *          判定，回写失败则丢弃——session 是 judge 的辅助信号而非门禁。
 */
import { performance } from "node:perf_hooks";
import type {
  Decision,
  DecisionLayer,
  ParsedCommand,
  ParsedShell,
  RiskLevel,
  ToolCall,
} from "../api/types.js";
import { applyAuditBackpressure, buildAuditRecord } from "../audit/index.js";
import { decide } from "../judge/index.js";
import { parseShellCommand } from "../parser/index.js";
import { evaluateToolCall } from "../rules/matcher.js";
import type { AclConfig, Engine, EngineOptions, JudgeOptions } from "./types.js";

/** judge 判定的固定置信度：校准概率不是确定性证据，低于规则/策略层的 1.0 */
const JUDGE_CONFIDENCE = 0.7;
/** 默认 ALLOW 的置信度：没有任何一层有意见，是"放行灰区"而非"确定安全" */
const DEFAULT_ALLOW_CONFIDENCE = 0.5;
/** indirect 启发式的置信度：parser 的确定性结构信号，但载荷不可见、无法判明意图 */
const INDIRECT_CONFIDENCE = 0.8;
/** indirect 启发式的审计标识：非 YAML 规则，用 meta. 前缀与具体类目规则区分 */
const INDIRECT_META_RULE_ID = "meta.indirect-execution";

const RISK_FROM_SCORE: readonly RiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

function isShellTool(call: ToolCall): boolean {
  return (
    call.tool.name.toLowerCase() === "shell" ||
    call.tool.category?.toLowerCase() === "shell"
  );
}

function toolMatches(names: readonly string[], call: ToolCall): boolean {
  const candidates = new Set(
    [call.tool.name, call.tool.category ?? ""].map((s) => s.toLowerCase()),
  );
  return names.some((name) => candidates.has(name.toLowerCase()));
}

/** ACL 判定；返回 DENY 理由，放行返回 undefined。语义见 types.ts。 */
export function checkAcl(acl: AclConfig | undefined, call: ToolCall): string | undefined {
  if (acl === undefined) return undefined;
  const entry = acl.agents?.[call.agent_id] ?? acl.default;
  if (entry === undefined) return undefined;

  if (entry.deny !== undefined && toolMatches(entry.deny, call)) {
    return `agent ${call.agent_id} ACL 黑名单命中工具 ${call.tool.name}`;
  }
  const gate =
    entry.tools?.[call.tool.name] ??
    (call.tool.category !== undefined ? entry.tools?.[call.tool.category] : undefined);
  if (gate !== undefined && !gate.allowed) {
    return `agent ${call.agent_id} ACL 禁用工具 ${call.tool.name}（allowed: false）`;
  }
  if (entry.allow !== undefined && !toolMatches(entry.allow, call)) {
    return `agent ${call.agent_id} ACL 白名单不含工具 ${call.tool.name}`;
  }
  return undefined;
}

/**
 * 与 parser/shell.ts 的 SHELL_EXECUTABLES / -c 探测保持一致；
 * 仅用于 reason 的间接形态描述——是否检出由 parser 写入的 indirect 标记决定。
 */
const SHELL_LIKE_EXECUTABLES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
]);
const SHELL_C_FLAG_RE = /^-[A-Za-z]*c/;

function commandBasename(executable: string): string {
  const slash = Math.max(executable.lastIndexOf("/"), executable.lastIndexOf("\\"));
  return (slash === -1 ? executable : executable.slice(slash + 1)).toLowerCase();
}

/** 间接执行形态的人类可读描述（eval / shell -c / 脚本文件 / stdin 管道 / xargs / source / 变量或命令替换的可执行位） */
function describeIndirectForm(cmd: ParsedCommand): string {
  const base = commandBasename(cmd.executable);
  if (base === "eval") return "eval 把拼接字符串当命令执行";
  if (base === "xargs") return "xargs 把管道/文件输入当命令执行";
  if (base === "source" || base === ".") return "source 动态加载脚本";
  if (SHELL_LIKE_EXECUTABLES.has(base)) {
    const args = cmd.args;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i] ?? "";
      if (arg === "--") {
        if (i + 1 < args.length) return `\`${base}\` 执行脚本文件（内容不在命令文本内）`;
        break;
      }
      if (SHELL_C_FLAG_RE.test(arg)) return `\`${base} -c\` 执行内联脚本载荷`;
      if (arg === "-") return `\`${base}\` 从 stdin 读取脚本（管道喂入）`;
      if (!arg.startsWith("-")) return `\`${base}\` 执行脚本文件（内容不在命令文本内）`;
    }
    return `\`${base}\` 从 stdin 读取脚本（管道喂入）`;
  }
  if (cmd.executable.includes("$") || cmd.executable.includes("`")) {
    return "可执行位由变量/命令替换展开，未经求值无法判明";
  }
  return "间接执行（parser indirect 标记）";
}

/** 首个带 indirect 标记的子命令；ordinal 是 1-based 序号（供审计与人阅读） */
function firstIndirectCommand(
  parsed: ParsedShell | undefined,
): { ordinal: number; cmd: ParsedCommand } | undefined {
  if (parsed === undefined) return undefined;
  for (let i = 0; i < parsed.commands.length; i += 1) {
    const cmd = parsed.commands[i];
    if (cmd !== undefined && cmd.indirect) return { ordinal: i + 1, cmd };
  }
  return undefined;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`judge 超时（>${String(timeoutMs)}ms）`));
    }, timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function riskFromScore(score: number): RiskLevel {
  const index = Math.min(Math.max(Math.round(score), 0), RISK_FROM_SCORE.length - 1);
  return RISK_FROM_SCORE[index] ?? "HIGH";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 回写 session 的输入摘录来源（命令/路径/URL 取首个非空串；截断由 store 负责） */
const EXCERPT_KEYS = ["command", "file_path", "path", "url"] as const;

function inputExcerpt(call: ToolCall): string | undefined {
  for (const key of EXCERPT_KEYS) {
    const value = call.input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function createEngine(options: EngineOptions): Engine {
  const judgeCfg: Required<Pick<JudgeOptions, "enabled" | "fail_closed" | "timeout_ms">> &
    JudgeOptions = {
    enabled: false,
    fail_closed: true,
    timeout_ms: 5000,
    ...options.judge,
  };

  async function check(rawCall: ToolCall): Promise<Decision> {
    let latencyMs = 0;
    let judgeUsed = false;

    // Session 注入（不变量 3）：带 session_id 时由网关侧 store 提供上下文，
    // 无条件覆盖调用方自报的 call.session；store 读失败则剥离自报字段，
    // 降级为无上下文判定（绝不让自报内容透传到判定层）。
    const store = options.sessionStore;
    let call = rawCall;
    if (store !== undefined && rawCall.session_id !== undefined) {
      try {
        call = { ...rawCall, session: store.snapshot(rawCall.session_id) };
      } catch {
        call = { ...rawCall };
        delete call.session;
      }
    }

    /** 每层调用都过 measure，耗时累加进 latency_ms */
    const measure = <T>(fn: () => T): T => {
      const start = performance.now();
      try {
        return fn();
      } finally {
        latencyMs += performance.now() - start;
      }
    };
    const measureAsync = async <T>(fn: () => Promise<T>): Promise<T> => {
      const start = performance.now();
      try {
        return await fn();
      } finally {
        latencyMs += performance.now() - start;
      }
    };

    /** 收尾：补 latency_ms / policy_version，写审计（含背压改写），回写 session，返回最终 Decision */
    const finish = (partial: Omit<Decision, "latency_ms" | "policy_version">): Decision => {
      const decision: Decision = {
        ...partial,
        latency_ms: Math.round(latencyMs * 1000) / 1000,
        ...(options.policyVersion !== undefined
          ? { policy_version: options.policyVersion }
          : {}),
      };
      const record = buildAuditRecord(call, decision, { judge_used: judgeUsed });
      const result = options.audit.record(record);
      const final = applyAuditBackpressure(decision, result);
      // 判定落定后回写（含背压改写后的有效判定）：网关侧记录
      // "它做过什么 + 结果如何"，供后续调用的 judge 识别重复试探（不变量 3）。
      // 回写失败不翻转已经作出的判定。
      if (store !== undefined && call.session_id !== undefined) {
        try {
          const excerpt = inputExcerpt(call);
          store.appendToolCall(call.session_id, {
            tool: `${call.tool.name} ${call.tool.action}`,
            decision: final.decision,
            ...(excerpt !== undefined ? { input_excerpt: excerpt } : {}),
          });
        } catch {
          /* session 是辅助信号：丢失一条历史不构成放行风险 */
        }
      }
      return final;
    };

    // 1. ACL
    const aclReason = measure(() => checkAcl(options.acl, call));
    if (aclReason !== undefined) {
      return finish({
        decision: "DENY",
        risk: "HIGH",
        confidence: 1,
        matched_rules: [],
        decision_layer: "acl",
        reason: aclReason,
      });
    }

    // 2. Parser（仅 shell 类工具；解析失败 fail-closed）
    let parsed: ParsedShell | undefined;
    if (isShellTool(call)) {
      const command = call.input.command;
      const result = measure(() =>
        typeof command === "string"
          ? parseShellCommand(command)
          : { ok: false as const, reason: "shell 工具的 input.command 缺失或不是字符串" },
      );
      if (!result.ok) {
        return finish({
          decision: "DENY",
          risk: "HIGH",
          confidence: 1,
          matched_rules: [],
          decision_layer: "parser",
          reason: `fail-closed：命令解析失败：${result.reason}`,
        });
      }
      parsed = result.shell;
    }

    // 3. Rules（命中 DENY/REVIEW 即短路）
    const ruleVerdict = measure(() => evaluateToolCall(options.rules, call, parsed));
    if (ruleVerdict !== undefined) {
      return finish({
        decision: ruleVerdict.decision,
        risk: ruleVerdict.risk,
        confidence: ruleVerdict.confidence,
        matched_rules: ruleVerdict.matched_rules,
        decision_layer: "rules",
        reason: ruleVerdict.reason,
      });
    }

    // 4. Policy（引擎异常同样 fail-closed）
    let policyVerdict: ReturnType<typeof options.policy.decide>;
    try {
      policyVerdict = measure(() => options.policy.decide({ call }));
    } catch (error) {
      return finish({
        decision: "DENY",
        risk: "HIGH",
        confidence: 1,
        matched_rules: [],
        decision_layer: "policy",
        reason: `fail-closed：policy 引擎异常：${errorMessage(error)}`,
      });
    }
    if (policyVerdict !== null) {
      const layer: DecisionLayer = "policy";
      const reason = `[${policyVerdict.policy_id}] ${policyVerdict.reason}`;
      if (policyVerdict.verdict === "ALLOW") {
        // 策略给出确定 ALLOW 是结论，灰区不再进 judge
        return finish({
          decision: "ALLOW",
          risk: "LOW",
          confidence: 1,
          matched_rules: [],
          decision_layer: layer,
          reason,
        });
      }
      return finish({
        decision: policyVerdict.verdict,
        risk: policyVerdict.verdict === "DENY" ? "HIGH" : "MEDIUM",
        confidence: 1,
        matched_rules: [],
        decision_layer: layer,
        reason,
      });
    }

    // 5. indirect 启发式兜底：任一子命令带 parser 的间接执行标记且前面各层
    //    无结论 → REVIEW。规则 DENY/REVIEW 与 policy 结论已在上面短路
    //    （deny-overrides 不被启发式抢走）；只兜"载荷不可见"的灰区。
    const indirectHit = measure(() => firstIndirectCommand(parsed));
    if (indirectHit !== undefined) {
      return finish({
        decision: "REVIEW",
        risk: "HIGH",
        confidence: INDIRECT_CONFIDENCE,
        matched_rules: [INDIRECT_META_RULE_ID],
        decision_layer: "rules",
        reason:
          `子命令 #${String(indirectHit.ordinal)} \`${indirectHit.cmd.executable}\` 检出间接执行：` +
          `${describeIndirectForm(indirectHit.cmd)}；载荷不可见，规则层无法判定，按兜底启发式要求人工复核`,
      });
    }

    // 6. Judge（仅灰区触发；默认关闭）
    if (judgeCfg.enabled) {
      judgeUsed = true;
      try {
        const judge = judgeCfg.judge;
        if (judge === undefined) {
          throw new Error("judge.enabled=true 但未提供 Judge 实例");
        }
        const answers = await measureAsync(() =>
          withTimeout(judge.assess(call), judgeCfg.timeout_ms),
        );
        const kind = decide(answers, judgeCfg.thresholds);
        return finish({
          decision: kind,
          risk: riskFromScore(answers.risk),
          confidence: JUDGE_CONFIDENCE,
          matched_rules: [],
          decision_layer: "judge",
          reason:
            `judge: risk=${String(answers.risk)} approval=${String(answers.approval)} ` +
            `user_requested=${String(answers.user_requested)} from_untrusted=${String(answers.from_untrusted)}`,
        });
      } catch (error) {
        if (judgeCfg.fail_closed) {
          return finish({
            decision: "DENY",
            risk: "HIGH",
            confidence: 1,
            matched_rules: [],
            decision_layer: "judge",
            reason: `fail-closed：judge 调用失败：${errorMessage(error)}`,
          });
        }
        return finish({
          decision: "ALLOW",
          risk: "LOW",
          confidence: DEFAULT_ALLOW_CONFIDENCE,
          matched_rules: [],
          decision_layer: "judge",
          reason: `judge 调用失败，fail_closed=false 放行：${errorMessage(error)}`,
        });
      }
    }

    // 7. 默认 ALLOW：rules 无命中、policy 无意见、无 indirect 迹象、judge 未启用
    return finish({
      decision: "ALLOW",
      risk: "LOW",
      confidence: DEFAULT_ALLOW_CONFIDENCE,
      matched_rules: [],
      decision_layer: "policy",
      reason: "rules 无命中、policy 无意见、judge 未启用，默认 ALLOW",
    });
  }

  return {
    check,
    close: () => options.audit.close(),
    ...(options.sessionStore !== undefined ? { session: options.sessionStore } : {}),
  };
}
