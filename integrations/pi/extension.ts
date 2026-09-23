/**
 * pi 适配器：进程内扩展（不走 stdin/stdout），挂 tool_call 事件
 * （调研报告 extensions/jev-guard.ts:14-28 段）。
 *
 *   pi.on("tool_call", async (event, ctx) => ...)
 *     event: { toolName, input }
 *     ctx:   { cwd, hasUI, ui: { confirm(title, message) → boolean, notify(...) },
 *              sessionManager?: { getSessionId?() }, signal }
 *     返回 { block: true, reason } 阻断；返回 undefined 放行。
 *
 * 三态落地（能力矩阵见 integrations/core/capabilities.ts）：
 *   ALLOW  → 返回 undefined 放行
 *   DENY   → { block: true, reason } 阻断
 *   REVIEW → 有 UI（ctx.hasUI 且 ctx.ui 可用）：ctx.ui.confirm 弹审批，
 *            拒绝则 block；无 UI：fail-closed 直接 block
 *            （与调研报告"无 UI 时 ask 直接 block"一致）
 *
 * 类型是 @earendil-works/pi-coding-agent ExtensionAPI 契约的最小结构镜像
 * （不引依赖，结构兼容即可被 pi 加载）；判定逻辑全部在核心引擎。
 */
import type { Engine } from "../../src/engine/index.js";
import { capabilityFor, summarizeDecision, translateDecision } from "../core/capabilities.js";
import { createHookEngine } from "../core/engine.js";
import { normalizePiCall } from "../core/normalize.js";
import { asString } from "../core/payload.js";

/** pi tool_call 事件（event.input 为工具参数对象） */
export interface PiToolCallEvent {
  toolName?: unknown;
  input?: unknown;
}

export interface PiUi {
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, level: string): void;
}

export interface PiContext {
  cwd?: unknown;
  hasUI?: boolean;
  ui?: PiUi;
  sessionManager?: { getSessionId?: () => string | undefined };
}

export interface PiBlock {
  block: true;
  reason: string;
}

export type PiToolCallHandler = (
  event: PiToolCallEvent,
  ctx: PiContext,
) => Promise<PiBlock | undefined>;

/** 结构匹配 @earendil-works/pi-coding-agent 的 ExtensionAPI（仅用到 on） */
export interface PiExtensionApi {
  on(event: "tool_call", handler: PiToolCallHandler): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createToolCallHandler(engine: Engine): PiToolCallHandler {
  return async (event, ctx) => {
    let call;
    try {
      const cwd = asString(ctx.cwd);
      const sessionId = ctx.sessionManager?.getSessionId?.();
      call = normalizePiCall(event.toolName, event.input, {
        ...(cwd !== undefined ? { cwd } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
    } catch (error) {
      // 事件形状不可信（不变量：调用方自报不可信）→ fail-closed 阻断
      return { block: true, reason: `AgentFence fail-closed 阻断：${errorMessage(error)}` };
    }

    let decision;
    try {
      decision = await engine.check(call);
    } catch (error) {
      // engine.check 设计上不抛（内部 fail-closed）；此分支是双保险
      return { block: true, reason: `AgentFence fail-closed 阻断：判定异常 ${errorMessage(error)}` };
    }

    // 有 UI 时 REVIEW 走 ctx.ui.confirm 原生审批；无 UI 按能力矩阵降级 block
    const ui = ctx.hasUI === true ? ctx.ui : undefined;
    const cap =
      ui !== undefined
        ? { ask: true as const, review: "ask" as const, note: "pi ctx.ui.confirm 人工审批" }
        : capabilityFor("pi");
    const t = translateDecision(decision, cap);
    const summary = summarizeDecision(decision);

    if (t.kind === "allow") return undefined;
    if (t.kind === "deny") {
      const reason =
        decision.decision === "REVIEW"
          ? (t.warning ?? `AgentFence REVIEW 降级阻断：${summary}`)
          : `AgentFence DENY：${summary}`;
      return { block: true, reason };
    }
    // t.kind === "ask"
    if (ui === undefined) {
      // 不可达（无 UI 时能力矩阵 review=block 已映射 deny），防御性 fail-closed
      return { block: true, reason: `AgentFence fail-closed 阻断：REVIEW 无审批通道可用` };
    }
    const approved = await ui.confirm("AgentFence: approve this tool call?", summary);
    return approved ? undefined : { block: true, reason: `User rejected: ${summary}` };
  };
}

/**
 * 默认导出：pi 加载扩展时调用（结构匹配 pi 的扩展入口契约）。
 * 引擎按 AGENTFENCE_CONFIG / cwd 下 agentfence.yaml / 仓库内置默认装配；
 * 装配失败按 fail-closed 抛错（pi 会拒绝加载该扩展并提示）。
 * 进程长驻，审计由 AuditQueue 后台 drain（best_effort）。
 */
export default function agentFenceExtension(pi: PiExtensionApi): void {
  pi.on("tool_call", createToolCallHandler(createHookEngine()));
}
