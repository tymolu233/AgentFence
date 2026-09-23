/**
 * Cursor 适配器：三个 pre-tool-use 事件（camelCase，调研报告
 * src/hook.js:115-123 段）：
 *
 *   beforeShellExecution  { command, cwd }                 → 合成 shell 调用
 *   beforeMCPExecution    { mcp_server_name, tool_name }   → 合成 mcp__<server>__<tool>
 *   preToolUse            { tool_name, tool_input, agent_message }
 *                         tool_input 是字符串，需二次 JSON.parse
 *
 * 响应：{ permission: allow|ask|deny, user_message?, agent_message? }。
 *
 * 降级：beforeShellExecution / beforeMCPExecution 支持 ask（REVIEW 原生
 * 映射）；preToolUse 不支持 ask，REVIEW 降级为 allow + user_message 警告。
 * agent_message 是 agent 自述意图而非用户发言，不进 session.user_intent。
 */
import type { Engine } from "../../src/engine/index.js";
import { evaluateHook } from "../core/hook.js";
import type { HostResponse } from "../core/types.js";

export function handlePayload(payload: unknown, engine: Engine): Promise<HostResponse> {
  return evaluateHook(payload, engine, { dialect: "cursor" });
}
