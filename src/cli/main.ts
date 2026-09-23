/**
 * CLI 主逻辑：agentfence check / exec。
 *
 * 退出码契约：0 = ALLOW，1 = DENY，2 = REVIEW。
 * 操作类错误（配置/规则/策略加载失败）按 fail-closed 视同 DENY → 1；
 * 用法错误（未知命令、缺参数）→ 64（EX_USAGE）。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Decision, DecisionKind, ToolCall } from "../api/types.js";
import { AuditLogWriter, AuditQueue } from "../audit/index.js";
import { createEngine, type Engine } from "../engine/index.js";
import { createPolicyEngine, loadPolicyFile } from "../policy/index.js";
import { loadRules } from "../rules/loader.js";
import { loadCliConfig, type CliConfig } from "./config.js";

const EXIT: Record<DecisionKind, number> = { ALLOW: 0, DENY: 1, REVIEW: 2 };
const EX_USAGE = 64;
const EX_NOTFOUND = 127;

const USAGE = `agentfence — AI Agent 工具调用执行安全网关

用法：
  agentfence check --tool <name> [--command <cmd>] [--action <a>] [--agent <id>]
                   [--json] [--config <path>]
  agentfence exec [--agent <id>] [--json] [--config <path>] -- <command...>

退出码：0 = ALLOW，1 = DENY，2 = REVIEW（exec 在 ALLOW 时透传被包装命令的退出码）
配置：默认读 cwd 下 agentfence.yaml；不存在则用内置默认（rules/ + policies/default.yaml，
审计写 .agentfence/audit.jsonl）。`;

interface ParsedArgs {
  flags: Map<string, string | true>;
  positionals: string[];
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else if (body === "json") {
        flags.set(body, true);
      } else {
        const value = args[i + 1];
        if (value === undefined) throw new CliUsageError(`参数 --${body} 缺值`);
        flags.set(body, value);
        i += 1;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

function flagString(flags: ReadonlyMap<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

/** 从配置装配 engine：规则 + 策略 + 审计队列（judge 无内置评分器，只透传开关） */
function buildEngine(config: CliConfig): Engine {
  const rules = loadRules(config.rulesDir);
  const policyConfig = loadPolicyFile(config.policyFile);
  const policy = createPolicyEngine(policyConfig);
  mkdirSync(path.dirname(config.auditPath), { recursive: true });
  const audit = new AuditQueue({
    writer: new AuditLogWriter(config.auditPath),
    mode: config.auditMode,
    spillPath: `${config.auditPath}.spill`,
  });
  return createEngine({
    rules,
    policy,
    policyVersion: `policy-v${String(policyConfig.version)}`,
    ...(config.acl !== undefined ? { acl: config.acl } : {}),
    judge: { enabled: config.judgeEnabled },
    audit,
  });
}

function printDecision(decision: Decision, json: boolean, out: (s: string) => void): void {
  if (json) {
    out(JSON.stringify(decision, null, 2));
    return;
  }
  const lines = [
    `Decision: ${decision.decision}`,
    `Risk:     ${decision.risk} (confidence ${String(decision.confidence)})`,
    `Layer:    ${decision.decision_layer}`,
    `Reason:   ${decision.reason}`,
  ];
  if (decision.matched_rules.length > 0) {
    lines.push(`Matched:  ${decision.matched_rules.join(", ")}`);
  }
  if (decision.latency_ms !== undefined) {
    lines.push(`Latency:  ${String(decision.latency_ms)}ms`);
  }
  out(lines.join("\n"));
}

function makeCall(
  flags: ReadonlyMap<string, string | true>,
  tool: string,
  input: Record<string, unknown>,
): ToolCall {
  return {
    request_id: randomUUID(),
    agent_id: flagString(flags, "agent") ?? "cli",
    tool: {
      name: tool,
      action: flagString(flags, "action") ?? "execute",
      category: tool.toLowerCase() === "shell" ? "shell" : undefined,
    },
    input,
  };
}

async function runCheck(args: readonly string[]): Promise<number> {
  const { flags } = parseArgs(args);
  const tool = flagString(flags, "tool");
  if (tool === undefined) throw new CliUsageError("check 需要 --tool <name>");
  const command = flagString(flags, "command");

  const config = loadCliConfig(flagString(flags, "config"));
  const engine = buildEngine(config);
  try {
    const call = makeCall(flags, tool, command !== undefined ? { command } : {});
    const decision = await engine.check(call);
    printDecision(decision, flags.get("json") === true, (s) => console.log(s));
    return EXIT[decision.decision];
  } finally {
    await engine.close();
  }
}

/** 执行被包装的命令：直接 spawn argv（不经 shell），透传退出码 */
function spawnWrapped(argv: readonly string[]): Promise<number> {
  return new Promise<number>((resolve) => {
    const [file, ...rest] = argv;
    if (file === undefined) {
      resolve(EX_USAGE);
      return;
    }
    const child = spawn(file, rest, { stdio: "inherit" });
    child.on("error", (error: NodeJS.ErrnoException) => {
      console.error(`agentfence: 无法执行 ${file}：${error.message}`);
      resolve(error.code === "ENOENT" ? EX_NOTFOUND : 1);
    });
    child.on("close", (code, signal) => {
      if (code !== null) {
        resolve(code);
      } else {
        console.error(`agentfence: 命令被信号 ${signal ?? "?"} 终止`);
        resolve(1);
      }
    });
  });
}

async function runExec(args: readonly string[]): Promise<number> {
  const separator = args.indexOf("--");
  if (separator < 0 || separator === args.length - 1) {
    throw new CliUsageError("exec 需要 -- <command...>");
  }
  const { flags } = parseArgs(args.slice(0, separator));
  const commandArgv = args.slice(separator + 1);

  const config = loadCliConfig(flagString(flags, "config"));
  const engine = buildEngine(config);
  let decision: Decision;
  try {
    // 判定对象是拼接后的命令字符串；执行走直接 spawn（不经 shell，无展开语义）
    const call = makeCall(flags, "shell", { command: commandArgv.join(" ") });
    decision = await engine.check(call);
  } finally {
    await engine.close();
  }

  if (decision.decision !== "ALLOW") {
    printDecision(decision, flags.get("json") === true, (s) => console.log(s));
    console.error(
      decision.decision === "DENY"
        ? "agentfence: DENY，命令未执行"
        : "agentfence: REVIEW，命令需人工审批，未执行",
    );
    return EXIT[decision.decision];
  }
  return spawnWrapped(commandArgv);
}

/** CLI 入口；返回退出码（由 index.ts 赋给 process.exitCode） */
export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "check":
        return await runCheck(rest);
      case "exec":
        return await runExec(rest);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        console.log(USAGE);
        return command === undefined ? EX_USAGE : 0;
      default:
        console.error(`agentfence: 未知命令 "${command}"\n\n${USAGE}`);
        return EX_USAGE;
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(`agentfence: ${error.message}\n\n${USAGE}`);
      return EX_USAGE;
    }
    // 操作类错误（配置/规则/策略加载失败）：fail-closed，视同 DENY
    console.error(
      `agentfence: 初始化失败（fail-closed，视同 DENY）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return EXIT.DENY;
  }
}
