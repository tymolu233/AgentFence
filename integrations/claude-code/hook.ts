/**
 * Claude Code 适配器：PreToolUse hook。
 *
 * payload（PascalCase 事件，调研报告 src/hook.js:11-16 段）：
 *   { hook_event_name: "PreToolUse", session_id, transcript_path, cwd,
 *     tool_name, tool_input: {...} }
 * 响应：{ hookSpecificOutput: { hookEventName: "PreToolUse",
 *        permissionDecision: allow|ask|deny, permissionDecisionReason } }
 * 三档齐全，REVIEW 原生映射 ask，无降级。
 */
import type { Engine } from "../../src/engine/index.js";
import { evaluateHook } from "../core/hook.js";
import type { HostResponse } from "../core/types.js";

export function handlePayload(payload: unknown, engine: Engine): Promise<HostResponse> {
  return evaluateHook(payload, engine, { dialect: "claude-code" });
}
