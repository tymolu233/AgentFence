/**
 * Codex 适配器：PreToolUse hook（payload 与 Claude Code 同形，
 * 多 turn_id + model —— 调研报告 src/hook.js:11-16 段据此区分两家）。
 *
 * 响应同 Claude 风格信封，但 Codex 没有 ask 决策：
 * REVIEW 降级为 permissionDecision "allow" + 顶层 systemMessage 警告
 * （能力矩阵见 integrations/core/capabilities.ts）。
 */
import type { Engine } from "../../src/engine/index.js";
import { evaluateHook } from "../core/hook.js";
import type { HostResponse } from "../core/types.js";

export function handlePayload(payload: unknown, engine: Engine): Promise<HostResponse> {
  return evaluateHook(payload, engine, { dialect: "codex" });
}
