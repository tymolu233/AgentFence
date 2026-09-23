/**
 * OpenCode 适配器：进程内插件（不走 stdin/stdout）。
 *
 * 挂两个钩子（调研报告 src/opencode.js:25-39 段）：
 *
 *   tool.execute.before(input, output)
 *     input:  { tool, sessionID, callID }
 *     output: { args }
 *     ALLOW → 原样返回；DENY → throw 阻断；REVIEW → 同样 throw
 *     （该 hook 无 ask 能力，throw 是唯一拦截手段，按 fail-closed 降级，
 *     与 pi "无 UI 时 ask 直接 block" 同族；错误消息区分 REVIEW 与 DENY）。
 *
 *   permission.ask(permission, output)
 *     OpenCode 自身就某调用发起权限询问时触发；从 permission 的
 *     metadata / pattern / title 重建参数送引擎判定，映射 output.status：
 *     ALLOW → "allow"，REVIEW → "ask"（原生人工审批），DENY → "deny"。
 *
 * 类型是 @opencode-ai/plugin 契约的最小结构镜像（不引依赖，结构兼容即可
 * 被 OpenCode 加载）；判定逻辑全部在核心引擎，本文件只做协议转换。
 */
import type { Decision } from "../../src/api/types.js";
import type { Engine } from "../../src/engine/index.js";
import { capabilityFor, summarizeDecision, translateDecision } from "../core/capabilities.js";
import { createHookEngine } from "../core/engine.js";
import { normalizeOpenCodeCall } from "../core/normalize.js";
import { asString, isRecord } from "../core/payload.js";

export interface OpenCodeToolExecuteBeforeInput {
  tool: string;
  sessionID?: string;
  callID?: string;
}

export interface OpenCodeToolExecuteBeforeOutput {
  args: Record<string, unknown>;
}

/** permission.ask 的权限请求（字段按 OpenCode 契约可选，缺啥降级重建） */
export interface OpenCodePermissionRequest {
  permission?: string;
  type?: string;
  pattern?: unknown;
  title?: string;
  metadata?: unknown;
}

export interface OpenCodePermissionOutput {
  status: "allow" | "ask" | "deny";
}

export interface OpenCodeHooks {
  "tool.execute.before": (
    input: OpenCodeToolExecuteBeforeInput,
    output: OpenCodeToolExecuteBeforeOutput,
  ) => Promise<void>;
  "permission.ask": (
    permission: OpenCodePermissionRequest,
    output: OpenCodePermissionOutput,
  ) => Promise<void>;
}

/** 结构匹配 @opencode-ai/plugin 的 Plugin 类型（context 本适配器用不到） */
export type AgentFencePlugin = (context: unknown) => Promise<OpenCodeHooks>;

/** 阻断错误：消息前缀区分 DENY（明确危险）与 REVIEW 降级阻断（需人工审批） */
export class AgentFenceBlockError extends Error {
  override readonly name = "AgentFenceBlockError";
  readonly decision: Decision;

  constructor(decision: Decision, message: string) {
    super(message);
    this.decision = decision;
  }
}

function blockMessage(decision: Decision, warning: string | undefined): string {
  if (decision.decision === "REVIEW") {
    // warning 已含"REVIEW 降级阻断"与能力说明（capabilities.ts）
    return warning ?? `AgentFence REVIEW 降级阻断：${summarizeDecision(decision)}`;
  }
  return `AgentFence DENY：${summarizeDecision(decision)}`;
}

/** permission.ask 的参数重建：metadata 为主，bash 类权限用 pattern 补 command */
function normalizePermission(permission: OpenCodePermissionRequest) {
  const toolName =
    asString(permission.permission) ?? asString(permission.type) ?? asString(permission.title) ?? "unknown";
  const input: Record<string, unknown> = isRecord(permission.metadata)
    ? { ...permission.metadata }
    : {};
  if (input.command === undefined) {
    if (typeof permission.pattern === "string") {
      input.command = permission.pattern;
    } else if (
      Array.isArray(permission.pattern) &&
      typeof permission.pattern[0] === "string"
    ) {
      input.command = permission.pattern[0];
    }
  }
  return normalizeOpenCodeCall(toolName, input);
}

export function createAgentFenceHooks(engine: Engine): OpenCodeHooks {
  return {
    "tool.execute.before": async (input, output) => {
      const call = normalizeOpenCodeCall(input.tool, output.args, {
        ...(input.sessionID !== undefined ? { sessionID: input.sessionID } : {}),
        ...(input.callID !== undefined ? { callID: input.callID } : {}),
      });
      const decision = await engine.check(call);
      const t = translateDecision(decision, capabilityFor("opencode"));
      if (t.kind === "deny") {
        throw new AgentFenceBlockError(decision, blockMessage(decision, t.warning));
      }
    },
    "permission.ask": async (permission, output) => {
      const decision = await engine.check(normalizePermission(permission));
      // 该钩子有原生 ask：REVIEW 不再降级，直接映射三档
      const t = translateDecision(decision, {
        ask: true,
        review: "ask",
        note: "OpenCode 原生权限询问通道",
      });
      output.status = t.kind;
    },
  };
}

/**
 * 默认导出：OpenCode 加载插件文件时调用。
 * 引擎按 AGENTFENCE_CONFIG / cwd 下 agentfence.yaml / 仓库内置默认装配；
 * 装配失败按 fail-closed 抛错（OpenCode 会拒绝加载该插件并提示）。
 * 进程长驻，审计由 AuditQueue 后台 drain（best_effort）。
 */
const plugin: AgentFencePlugin = () =>
  Promise.resolve(createAgentFenceHooks(createHookEngine()));

export default plugin;
