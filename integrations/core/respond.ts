/**
 * 回译：Decision → 各宿主 hook 响应 JSON（写 stdout，exit 0）。
 *
 * 响应形状按宿主 hook 契约（调研报告 src/hook.js:79-123 段）：
 * - claude-code：hookSpecificOutput.permissionDecision = allow|ask|deny
 * - codex：同 Claude 风格信封，但无 ask —— REVIEW 降级为 allow +
 *   顶层 systemMessage 警告（Codex 会把 systemMessage 展示给用户）
 * - copilot：permissionDecision 同时放顶层与 hookSpecificOutput 信封
 *   （调研报告 src/hook.js:84-85 段同款双写），三档齐全原生 ask
 * - gemini-cli：{ decision: allow|deny, reason, systemMessage? }，
 *   无 ask —— REVIEW 降级为 allow + systemMessage 警告
 * - cursor：{ permission: allow|ask|deny, user_message?, agent_message? }；
 *   preToolUse 无 ask —— REVIEW 降级为 allow + user_message 警告
 * - grok-cli：{ decision: approve|block, reason? }；无 ask 且警告字段无人
 *   消费 —— REVIEW 降级为 block（exit 2 + stderr 原因）
 * - opencode / pi 是进程内插件、acp 是 JSON-RPC 代理，不走 stdout，
 *   其回译在各自适配器目录
 *
 * deny 时给 agent 看的消息要说明"未执行 + 原因"，让 agent 转告用户，
 * 而不是静默失败。
 */
import type { Decision } from "../../src/api/types.js";
import { capabilityFor, summarizeDecision, translateDecision } from "./capabilities.js";
import type { HostDialect, HostResponse, StdioDialect } from "./types.js";

function respond(payload: Record<string, unknown>): HostResponse {
  return { stdout: JSON.stringify(payload), exitCode: 0 };
}

/** Claude 风格信封；copilot 额外在顶层双写 permissionDecision（宿主读顶层） */
function claudeStyleResponse(
  decision: Decision,
  dialect: "claude-code" | "codex" | "copilot",
): HostResponse {
  const t = translateDecision(decision, capabilityFor(dialect));
  const inner = {
    hookEventName: "PreToolUse",
    permissionDecision: t.kind,
    permissionDecisionReason: summarizeDecision(decision),
  };
  const payload: Record<string, unknown> =
    dialect === "copilot"
      ? {
          permissionDecision: inner.permissionDecision,
          permissionDecisionReason: inner.permissionDecisionReason,
          hookSpecificOutput: inner,
        }
      : { hookSpecificOutput: inner };
  if (t.warning !== undefined) payload.systemMessage = t.warning;
  return respond(payload);
}

function geminiResponse(decision: Decision): HostResponse {
  const t = translateDecision(decision, capabilityFor("gemini-cli"));
  // Gemini BeforeTool 契约没有 ask：translateDecision 已把 REVIEW 降级为 allow
  const payload: Record<string, unknown> = {
    decision: t.kind === "deny" ? "deny" : "allow",
    reason: summarizeDecision(decision),
  };
  if (t.warning !== undefined) payload.systemMessage = t.warning;
  return respond(payload);
}

/**
 * grok-cli：hook 输出 { decision: "approve"|"block", reason? }；exit 2 =
 * 阻断，且只有 stderr 文本会被宿主拼给 agent（src/grok/tools.ts:108-111
 * 的 [Hook blocked] <stderr>）。无 ask、警告字段无人消费，REVIEW 已按
 * 能力矩阵降级 block。
 */
function grokResponse(decision: Decision): HostResponse {
  const t = translateDecision(decision, capabilityFor("grok-cli"));
  if (t.kind === "allow") {
    return respond({ decision: "approve", reason: summarizeDecision(decision) });
  }
  const message = t.warning ?? `AgentFence DENY：${summarizeDecision(decision)}（调用未执行）`;
  return {
    stdout: JSON.stringify({ decision: "block", reason: message }),
    exitCode: 2,
    stderr: message,
  };
}

function cursorResponse(decision: Decision, event: string): HostResponse {
  const t = translateDecision(decision, capabilityFor("cursor", event));
  const payload: Record<string, unknown> = { permission: t.kind };
  if (t.kind === "deny") {
    // 阻断原因同时给用户与 agent；agent 据此转告用户"调用未执行"
    payload.user_message = `AgentFence 阻断：${summarizeDecision(decision)}`;
    payload.agent_message = `AgentFence 拦截了该工具调用（未执行）：${summarizeDecision(decision)}`;
  } else if (t.kind === "ask") {
    payload.user_message = `AgentFence 要求人工审批：${summarizeDecision(decision)}`;
  }
  if (t.warning !== undefined) payload.user_message = t.warning;
  return respond(payload);
}

export function toHostResponse(
  dialect: StdioDialect,
  event: string,
  decision: Decision,
): HostResponse {
  switch (dialect) {
    case "claude-code":
    case "codex":
    case "copilot":
      return claudeStyleResponse(decision, dialect);
    case "gemini-cli":
      return geminiResponse(decision);
    case "cursor":
      return cursorResponse(decision, event);
    case "grok-cli":
      return grokResponse(decision);
  }
}

/**
 * fail-closed 兜底响应：payload 无法识别 / 归一化失败 / 引擎初始化失败时，
 * 在已知方言内回 DENY；方言也不可识别时回通用 deny 形状。
 */
export function denyResponse(dialect: HostDialect | undefined, reason: string): HostResponse {
  const message = `AgentFence fail-closed 阻断：${reason}`;
  switch (dialect) {
    case "claude-code":
    case "codex":
      return respond({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: message,
        },
      });
    case "copilot":
      return respond({
        permissionDecision: "deny",
        permissionDecisionReason: message,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: message,
        },
      });
    case "gemini-cli":
      return respond({ decision: "deny", reason: message });
    case "cursor":
      return respond({ permission: "deny", user_message: message, agent_message: message });
    case "grok-cli":
      // exit 2 是 grok hook 契约的阻断信号；stderr 才会被拼给 agent
      return {
        stdout: JSON.stringify({ decision: "block", reason: message }),
        exitCode: 2,
        stderr: message,
      };
    case "opencode":
    case "pi":
    case "acp":
    case undefined:
      return respond({ decision: "deny", reason: message });
  }
}

/** 非 pre-tool-use 事件的直通放行（网关只把守执行前点位） */
export function allowThroughResponse(
  dialect: HostDialect | undefined,
  reason: string,
): HostResponse {
  switch (dialect) {
    case "claude-code":
    case "codex":
      return respond({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: reason,
        },
      });
    case "copilot":
      return respond({
        permissionDecision: "allow",
        permissionDecisionReason: reason,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: reason,
        },
      });
    case "gemini-cli":
      return respond({ decision: "allow", reason });
    case "cursor":
      return respond({ permission: "allow" });
    case "grok-cli":
      return respond({ decision: "approve", reason });
    case "opencode":
    case "pi":
    case "acp":
    case undefined:
      return respond({ decision: "allow", reason });
  }
}
