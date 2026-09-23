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
 * - grok-build：{ decision: allow|ask|deny, reason? }，三档齐全原生 ask
 *   （xai-grok-hooks/src/runner/mod.rs DecisionToken）。DENY 走 exit 2 +
 *   stderr + stdout JSON 三写：宿主 hook 失败 fail-open，exit 2 是唯一
 *   不依赖 stdout JSON 的阻断信号（parse_blocking_result：JSON deny 任意
 *   退出码都生效；stdout 损坏时 exit 2 + stderr 首行仍阻断）
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
 * grok-build：hook 输出 { decision: allow|ask|deny, reason? }（顶层 decision
 * 与 hookSpecificOutput.permissionDecision 等价，用顶层）。三档齐全，
 * REVIEW 原生映射 ask（进宿主权限提示，reason 展示给用户）。
 * allow/ask 必须 exit 0 —— exit 2 会把 stdout 的 allow/ask 压成 deny
 * （parse_blocking_result "stdout is ignored on exit 2"）。
 * deny 走 exit 2 + stderr + JSON 三写：宿主对 hook 失败一律 fail-open，
 * exit 2 是唯一不依赖 stdout JSON 的阻断通道，stderr 首行在 JSON 损坏时
 * 兜底为阻断原因。
 */
function grokBuildResponse(decision: Decision): HostResponse {
  const t = translateDecision(decision, capabilityFor("grok-build"));
  const summary = summarizeDecision(decision);
  if (t.kind === "allow") {
    return respond({ decision: "allow", reason: summary });
  }
  if (t.kind === "ask") {
    return respond({ decision: "ask", reason: `AgentFence 人工审批：${summary}` });
  }
  const message = t.warning ?? `AgentFence DENY：${summary}（调用未执行）`;
  return {
    stdout: JSON.stringify({ decision: "deny", reason: message }),
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
    case "grok-build":
      return grokBuildResponse(decision);
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
    case "grok-build":
      // exit 2 是 grok-build hook 契约里唯一不依赖 stdout JSON 的阻断信号；
      // stderr 首行在 JSON 损坏时兜底为阻断原因
      return {
        stdout: JSON.stringify({ decision: "deny", reason: message }),
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
    case "grok-build":
      return respond({ decision: "allow", reason });
    case "opencode":
    case "pi":
    case "acp":
    case undefined:
      return respond({ decision: "allow", reason });
  }
}
