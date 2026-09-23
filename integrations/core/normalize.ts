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

/**
 * Claude Code / Codex / Copilot / grok-cli：PascalCase 事件 + tool_name +
 * tool_input 对象。Copilot 多一个 ISO timestamp 字段（归一化忽略，只做
 * 方言识别特征）；grok-cli 的 PreToolUse 形状与 Claude Code 完全同形
 * （superagent-ai/grok-cli src/hooks/types.ts PreToolUseHookInput），
 * 只能靠安装点位钉方言区分。
 */
function normalizeClaudeStyle(
  payload: Record<string, unknown>,
  dialect: "claude-code" | "codex" | "copilot" | "grok-cli",
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
    case "copilot":
    case "grok-cli":
      return normalizeClaudeStyle(payload, dialect);
    case "gemini-cli":
      return normalizeGemini(payload);
    case "cursor":
      return normalizeCursor(payload);
    case "opencode":
    case "pi":
    case "acp":
      // opencode/pi 是进程内插件、acp 是 JSON-RPC 代理，均不走 stdin payload；
      // 各有专用归一化入口（normalizeOpenCodeCall / normalizePiCall / normalizeAcpRequest）
      fail(`${dialect} 方言无 stdin payload，请用专用归一化入口`);
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

/**
 * pi 进程内扩展的归一化入口：tool_call 事件的 event.toolName + event.input
 * （调研报告 extensions/jev-guard.ts:14-17 段）。ctx.cwd 进 context。
 */
export function normalizePiCall(
  toolName: unknown,
  input: unknown,
  extra: { cwd?: string; sessionId?: string } = {},
): ToolCall {
  const name = asString(toolName) ?? fail("pi tool_call 的 toolName 缺失或不是非空字符串");
  if (input !== undefined && !isRecord(input)) fail("pi tool_call 的 input 必须是对象");
  return {
    request_id: randomUUID(),
    agent_id: "pi",
    ...(extra.sessionId !== undefined ? { session_id: extra.sessionId } : {}),
    tool: toToolRef(name),
    input: input ?? {},
    ...(extra.cwd !== undefined ? { context: { cwd: extra.cwd } } : {}),
  };
}

/** ACP 代理把守的两个 agent→client 执行前方法（其余方法直通不判定） */
export const ACP_GUARDED_METHODS = new Set(["terminal/create", "fs/write_text_file"]);

/**
 * ACP JSON-RPC 请求的归一化入口（调研报告 src/acp.js:44-49 段）：
 *   terminal/create      {sessionId, command, args?, cwd?} → {tool:"Bash", input:{command,cwd?}}
 *                        （command 与 args 数组 join 成完整命令行）
 *   fs/write_text_file   {sessionId, path, content}        → {tool:"Write", input:{file_path,content}}
 * 其余方法不在网关把守范围，代理直接直通（不调本函数）。
 * 参数非法一律 NormalizeError → 上层 fail-closed 回 JSON-RPC error -32000。
 */
export function normalizeAcpRequest(method: string, params: unknown): ToolCall {
  const p = isRecord(params) ? params : fail(`ACP ${method} 的 params 必须是对象`);
  const sessionId = asString(p.sessionId);
  const cwd = asString(p.cwd);

  if (method === "terminal/create") {
    const command = requireString(p.command, "terminal/create 的 command");
    const args = p.args === undefined ? [] : p.args;
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      fail("terminal/create 的 args 必须是字符串数组");
    }
    const full = [command, ...(args as string[])].join(" ");
    return {
      request_id: randomUUID(),
      agent_id: "acp",
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      tool: { name: "Bash", action: "execute", category: "shell" },
      input: { command: full, ...(cwd !== undefined ? { cwd } : {}) },
      ...(cwd !== undefined ? { context: { cwd } } : {}),
    };
  }
  if (method === "fs/write_text_file") {
    const filePath = requireString(p.path, "fs/write_text_file 的 path");
    if (typeof p.content !== "string") fail("fs/write_text_file 的 content 必须是字符串");
    return {
      request_id: randomUUID(),
      agent_id: "acp",
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      tool: { name: "Write", action: "write", category: "filesystem" },
      input: { file_path: filePath, content: p.content },
    };
  }
  fail(`ACP 方法 ${method} 不在把守范围（ACP_GUARDED_METHODS），不应送归一化`);
}
