/**
 * 归一化：各宿主 payload → 统一 ToolCall（src/api/types.ts 权威契约）。
 *
 * 适配器只做协议转换，判定逻辑只在核心（docs/architecture.md "Agent 适配"）。
 * 形状非法一律 NormalizeError → 上层 fail-closed 转 DENY（不变量 5）。
 * 非 pre-tool-use 事件（PostToolUse / AfterTool / SessionStart 等）抛
 * OutOfScopeEvent → 上层直接放行，不送判定（网关只把守执行前点位）。
 */
import { randomUUID } from "node:crypto";
import type { ToolCall } from "../../src/api/types.js";
import { asString, isRecord } from "./payload.js";
import { toToolRef } from "./tools.js";
import type { CursorEvent, HostDialect, NormalizedHook } from "./types.js";

export class NormalizeError extends Error {
  override readonly name = "NormalizeError";
}

/** 事件存在但不是执行前点位：不判定、直接放行 */
export class OutOfScopeEvent extends Error {
  override readonly name = "OutOfScopeEvent";
}

function fail(message: string): never {
  throw new NormalizeError(message);
}

function requireString(value: unknown, where: string): string {
  const s = asString(value);
  if (s === undefined) fail(`${where} 缺失或不是非空字符串`);
  return s;
}

/** tool_input 必须是对象（缺省按 {}）；其余形状 fail-closed */
function asToolInput(value: unknown, where: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) fail(`${where} 必须是对象`);
  return value;
}

function baseCall(
  dialect: HostDialect,
  payload: Record<string, unknown>,
  toolName: string,
  input: Record<string, unknown>,
): ToolCall {
  const cwd = asString(payload.cwd);
  const sessionId = asString(payload.session_id);
  const runId = asString(payload.turn_id);
  return {
    request_id: randomUUID(),
    agent_id: dialect,
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    ...(runId !== undefined ? { run_id: runId } : {}),
    tool: toToolRef(toolName),
    input,
    ...(cwd !== undefined ? { context: { cwd } } : {}),
  };
}

/** Claude Code / Codex：PascalCase 事件 + tool_name + tool_input 对象 */
function normalizeClaudeStyle(
  payload: Record<string, unknown>,
  dialect: "claude-code" | "codex",
): NormalizedHook {
  const event = asString(payload.hook_event_name) ?? "PreToolUse";
  if (event !== "PreToolUse") {
    throw new OutOfScopeEvent(`事件 ${event} 不是执行前点位，不送判定`);
  }
  const toolName = requireString(payload.tool_name, "tool_name");
  const input = asToolInput(payload.tool_input, "tool_input");
  return { dialect, event, call: baseCall(dialect, payload, toolName, input) };
}

/** Gemini CLI：BeforeTool 事件，字段同为 tool_name / tool_input */
function normalizeGemini(payload: Record<string, unknown>): NormalizedHook {
  const event = asString(payload.hook_event_name) ?? "BeforeTool";
  if (event !== "BeforeTool") {
    throw new OutOfScopeEvent(`事件 ${event} 不是执行前点位，不送判定`);
  }
  const toolName = requireString(payload.tool_name, "tool_name");
  const input = asToolInput(payload.tool_input, "tool_input");
  return { dialect: "gemini-cli", event, call: baseCall("gemini-cli", payload, toolName, input) };
}

function detectCursorEvent(payload: Record<string, unknown>): CursorEvent {
  const declared = asString(payload.hook_event_name);
  if (declared !== undefined) {
    if (declared === "beforeShellExecution" || declared === "beforeMCPExecution" || declared === "preToolUse") {
      return declared;
    }
    throw new OutOfScopeEvent(`Cursor 事件 ${declared} 不是执行前点位，不送判定`);
  }
  // 字段回退（调研报告 src/hook.js:115-123 段：三事件字段互斥）
  if (asString(payload.mcp_server_name) !== undefined) return "beforeMCPExecution";
  if (typeof payload.tool_input === "string") return "preToolUse";
  if (asString(payload.command) !== undefined) return "beforeShellExecution";
  fail("无法识别 Cursor 事件（缺 hook_event_name 且字段不匹配三事件之一）");
}

/** Cursor：camelCase 三事件，形状互不相同 */
function normalizeCursor(payload: Record<string, unknown>): NormalizedHook {
  const event = detectCursorEvent(payload);
  const cwd = asString(payload.cwd);

  switch (event) {
    case "beforeShellExecution": {
      const command = requireString(payload.command, "command");
      const call: ToolCall = {
        request_id: randomUUID(),
        agent_id: "cursor",
        tool: { name: "shell", action: "execute", category: "shell" },
        input: { command },
        ...(cwd !== undefined ? { context: { cwd } } : {}),
      };
      return { dialect: "cursor", event, call };
    }
    case "beforeMCPExecution": {
      const server = requireString(payload.mcp_server_name, "mcp_server_name");
      const tool = requireString(payload.tool_name, "tool_name");
      // 合成工具名 mcp__<server>__<tool>（调研报告同款），category "mcp" 供 ACL/审计路由
      const call: ToolCall = {
        request_id: randomUUID(),
        agent_id: "cursor",
        tool: { name: `mcp__${server}__${tool}`, action: "execute", category: "mcp" },
        input: asToolInput(payload.tool_input, "tool_input"),
        ...(cwd !== undefined ? { context: { cwd } } : {}),
      };
      return { dialect: "cursor", event, call };
    }
    case "preToolUse": {
      const toolName = requireString(payload.tool_name, "tool_name");
      // preToolUse 的 tool_input 是字符串，需二次 JSON.parse；失败 fail-closed
      const raw = payload.tool_input;
      if (raw === undefined) {
        return {
          dialect: "cursor",
          event,
          call: baseCall("cursor", payload, toolName, {}),
        };
      }
      if (typeof raw !== "string") fail("preToolUse 的 tool_input 必须是字符串（Cursor 契约）");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        fail(
          `preToolUse 的 tool_input 二次 JSON.parse 失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (!isRecord(parsed)) fail("preToolUse 的 tool_input 解析后必须是对象");
      // agent_message 是 agent 自述意图而非用户发言（不变量 4 精神），不进 session.user_intent
      return { dialect: "cursor", event, call: baseCall("cursor", payload, toolName, parsed) };
    }
  }
}

export function normalizePayload(
  payload: Record<string, unknown>,
  dialect: HostDialect,
): NormalizedHook {
  switch (dialect) {
    case "claude-code":
    case "codex":
      return normalizeClaudeStyle(payload, dialect);
    case "gemini-cli":
      return normalizeGemini(payload);
    case "cursor":
      return normalizeCursor(payload);
    case "opencode":
      // OpenCode 是进程内插件，不走 stdin payload；用 normalizeOpenCodeCall
      fail("opencode 方言无 stdin payload，请用 normalizeOpenCodeCall");
  }
}

/**
 * OpenCode 进程内插件的归一化入口：tool.execute.before 的
 * input.tool + output.args（调研报告 src/opencode.js:25-39 段）。
 */
export function normalizeOpenCodeCall(
  tool: string,
  args: Record<string, unknown>,
  ids: { sessionID?: string; callID?: string } = {},
): ToolCall {
  const toolName = asString(tool) ?? fail("opencode input.tool 缺失或不是非空字符串");
  return {
    request_id: randomUUID(),
    agent_id: "opencode",
    ...(ids.sessionID !== undefined ? { session_id: ids.sessionID } : {}),
    ...(ids.callID !== undefined ? { run_id: ids.callID } : {}),
    tool: toToolRef(toolName),
    input: args,
  };
}
