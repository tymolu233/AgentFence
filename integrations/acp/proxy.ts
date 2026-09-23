/**
 * ACP 适配器：JSON-RPC stdio 代理（调研报告 src/acp.js 的 TypeScript 移植）。
 *
 * 位置：ACP 客户端（Zed / JetBrains / …）⇄ 本代理 ⇄ ACP agent 子进程。
 * NDJSON 帧（一行一个 JSON-RPC 消息），双向转发；代理只把守
 * agent→client 的两个执行前方法（调研报告 src/acp.js:44-49 段）：
 *
 *   terminal/create      → { tool: "Bash", input: { command, cwd? } }
 *   fs/write_text_file   → { tool: "Write", input: { file_path, content } }
 *
 * 三态落地（调研报告 src/acp.js:56-66 段）：
 *   ALLOW  → 原样转发给客户端
 *   REVIEW → 代理注入 session/request_permission 向客户端要批准
 *            （选项 allow_once / reject_once）；批准 → 转发原请求，
 *            拒绝/取消/客户端报错 → 回 JSON-RPC error -32000
 *   DENY   → 直接回 JSON-RPC error -32000（不转发）
 *
 * 其余消息（initialize、session/new、session/prompt、session/update、
 * fs/read_text_file 及全部响应）一律直通不判定 —— 网关只把守执行前点位。
 * 归一化失败 / 引擎异常一律 fail-closed 回 -32000。
 * 代理自注请求用字符串 id（agentfence:N），与 agent 的数字 id 不冲突。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Decision } from "../../src/api/types.js";
import type { Engine } from "../../src/engine/index.js";
import { capabilityFor, summarizeDecision, translateDecision } from "../core/capabilities.js";
import { createHookEngine } from "../core/engine.js";
import { ACP_GUARDED_METHODS, normalizeAcpRequest } from "../core/normalize.js";
import { asString, isRecord } from "../core/payload.js";

export type JsonRpcId = string | number;

/** JSON-RPC 消息的最小结构镜像（入向消息按 unknown 收窄后使用） */
export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** 阻断 / 拒绝回包的错误码（调研报告 src/acp.js:66 段） */
export const ACP_DENY_ERROR_CODE = -32000;

export interface AcpProxySinks {
  /** 发向 ACP 客户端（编辑器侧） */
  toClient: (msg: JsonRpcMessage) => void;
  /** 发向 ACP agent（子进程侧） */
  toAgent: (msg: JsonRpcMessage) => void;
  /** 诊断输出（默认 stderr） */
  warn?: (message: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** input 的短预览（permission 弹窗标题用，不含全文） */
function preview(input: Record<string, unknown>, max = 120): string {
  const text = asString(input.command) ?? asString(input.file_path) ?? JSON.stringify(input) ?? "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export class AcpProxy {
  private seq = 0;
  /** 代理注入客户端的请求 id → resolve（其响应不回 agent） */
  private readonly ours = new Map<JsonRpcId, (msg: JsonRpcMessage) => void>();
  private readonly warn: (message: string) => void;

  constructor(
    private readonly engine: Engine,
    private readonly sinks: AcpProxySinks,
  ) {
    this.warn = sinks.warn ?? (() => undefined);
  }

  /** agent→client 方向。请求先过判定；响应与通知直通。 */
  async handleAgentMessage(raw: unknown): Promise<void> {
    if (!isRecord(raw)) {
      this.warn("agent 消息不是 JSON 对象，已丢弃");
      return;
    }
    const msg = raw as JsonRpcMessage;
    if (typeof msg.method === "string" && msg.id !== undefined) {
      const rejection = await this.guardRequest(msg, msg.method, msg.id);
      if (rejection !== undefined) {
        this.sinks.toAgent(rejection);
        return;
      }
    }
    this.sinks.toClient(msg);
  }

  /** client→agent 方向。代理自注请求的响应在此截获；其余直通。 */
  handleClientMessage(raw: unknown): void {
    if (!isRecord(raw)) {
      this.warn("client 消息不是 JSON 对象，已丢弃");
      return;
    }
    const msg = raw as JsonRpcMessage;
    if (msg.id !== undefined && msg.method === undefined) {
      const resolve = this.ours.get(msg.id);
      if (resolve !== undefined) {
        this.ours.delete(msg.id);
        resolve(msg);
        return;
      }
    }
    this.sinks.toAgent(msg);
  }

  private askClient(method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = `agentfence:${++this.seq}`;
    return new Promise((resolve) => {
      this.ours.set(id, resolve);
      this.sinks.toClient({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** 返回 undefined 表示放行（转发）；否则为回给 agent 的 JSON-RPC error */
  private async guardRequest(
    msg: JsonRpcMessage,
    method: string,
    id: JsonRpcId,
  ): Promise<JsonRpcMessage | undefined> {
    if (!ACP_GUARDED_METHODS.has(method)) return undefined;

    let decision: Decision;
    let input: Record<string, unknown>;
    try {
      const call = normalizeAcpRequest(method, msg.params);
      input = call.input;
      decision = await this.engine.check(call);
    } catch (error) {
      // 归一化失败 / 引擎异常：fail-closed（engine.check 设计上不抛，双保险）
      return this.rejection(id, `AgentFence fail-closed 阻断：${errorMessage(error)}`);
    }

    const t = translateDecision(decision, capabilityFor("acp"));
    const summary = summarizeDecision(decision);
    if (t.kind === "allow") return undefined;
    if (t.kind === "deny") {
      return this.rejection(id, `AgentFence DENY：${summary}（调用未执行）`);
    }

    // REVIEW → session/request_permission 向客户端要批准（原生 ask 通道）
    const params = isRecord(msg.params) ? msg.params : {};
    const sessionId = asString(params.sessionId);
    const res = await this.askClient("session/request_permission", {
      ...(sessionId !== undefined ? { sessionId } : {}),
      toolCall: {
        toolCallId: `agentfence-${this.seq}`,
        title: `AgentFence 审批：${method === "terminal/create" ? "Bash" : "Write"} ${preview(input)}`,
        kind: method === "terminal/create" ? "execute" : "edit",
        status: "pending",
        rawInput: input,
      },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    const outcome = isRecord(res.result) ? res.result.outcome : undefined;
    if (isRecord(outcome) && outcome.outcome === "selected" && outcome.optionId === "allow") {
      return undefined;
    }
    return this.rejection(id, `User rejected: ${summary}`);
  }

  private rejection(id: JsonRpcId, message: string): JsonRpcMessage {
    return { jsonrpc: "2.0", id, error: { code: ACP_DENY_ERROR_CODE, message } };
  }
}

export interface RunProxyOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  /** 缺省按 AGENTFENCE_CONFIG / cwd agentfence.yaml / 仓库内置默认装配 */
  engine?: Engine;
  onExit?: (code: number) => void;
  warn?: (message: string) => void;
}

/**
 * 启动代理：spawn agent 子进程，client⇄proxy⇄agent 三线接通。
 * 方向内顺序处理（promise 链），保证异步判定不打乱消息顺序。
 */
export function runProxy(cmd: string, args: string[], options: RunProxyOptions = {}): ChildProcess {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const warn =
    options.warn ?? ((message: string) => process.stderr.write(`agentfence acp: ${message}\n`));
  const engine = options.engine ?? createHookEngine();
  const onExit = options.onExit ?? ((code: number) => process.exit(code));

  const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: options.env ?? process.env,
  });
  if (child.stdin === null || child.stdout === null) {
    throw new Error("agent 子进程 stdio 管道不可用");
  }
  const agentIn = child.stdin;
  const proxy = new AcpProxy(engine, {
    toClient: (m) => {
      stdout.write(JSON.stringify(m) + "\n");
    },
    toAgent: (m) => {
      agentIn.write(JSON.stringify(m) + "\n");
    },
    warn,
  });

  pipe(child.stdout, (m) => proxy.handleAgentMessage(m), warn);
  pipe(stdin, (m) => Promise.resolve(proxy.handleClientMessage(m)), warn);
  stdin.on("end", () => agentIn.end());
  child.on("exit", (code) => {
    // 关队列落盘审计是 best effort，不能挡住代理退出
    void engine
      .close()
      .catch(() => undefined)
      .then(() => onExit(code ?? 0));
  });
  return child;
}

/** NDJSON 逐行解析；非 JSON 行告警丢弃。方向内顺序执行，消息顺序不被异步判定打乱 */
function pipe(
  stream: NodeJS.ReadableStream,
  handler: (msg: unknown) => Promise<void>,
  warn: (message: string) => void,
): void {
  let chain = Promise.resolve();
  createInterface({ input: stream }).on("line", (line) => {
    if (line.trim().length === 0) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      warn(`非 JSON 行已丢弃：${line.slice(0, 80)}`);
      return;
    }
    chain = chain.then(() => handler(msg)).catch((error: unknown) => warn(errorMessage(error)));
  });
}
