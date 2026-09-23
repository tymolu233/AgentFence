/**
 * Copilot CLI 适配器：PreToolUse hook。
 *
 * payload 与 Claude Code 几乎同形（PascalCase 事件 + tool_name/tool_input
 * 对象），多一个 ISO timestamp 字段 —— 调研报告 src/hook.js:11-16 段
 * 据此与 Codex（turn_id + model）、Claude Code（两者皆无）区分：
 *   { hook_event_name: "PreToolUse", session_id, cwd, timestamp,
 *     tool_name, tool_input: {...} }
 *
 * 响应（调研报告 src/hook.js:84-85 段，顶层与信封双写）：
 *   { permissionDecision: allow|ask|deny, permissionDecisionReason,
 *     hookSpecificOutput: { hookEventName: "PreToolUse",
 *       permissionDecision, permissionDecisionReason } }
 * 三档齐全，REVIEW 原生映射 ask，无降级（云端 agent 形态下宿主自身把
 * ask 当 deny 处理，见能力矩阵注释）。
 */
import type { Engine } from "../../src/engine/index.js";
import { evaluateHook } from "../core/hook.js";
import type { HostResponse } from "../core/types.js";

export function handlePayload(payload: unknown, engine: Engine): Promise<HostResponse> {
  return evaluateHook(payload, engine, { dialect: "copilot" });
}
