/**
 * Gemini CLI 适配器：BeforeTool hook。
 *
 * payload：{ hook_event_name: "BeforeTool", tool_name, tool_input, ... }
 * （调研报告 src/hook.js:101-111 段；AfterTool / BeforeAgent 不是执行前
 * 点位，直通放行不送判定）。
 * 响应：{ decision: allow|deny, reason, systemMessage? }。
 *
 * 降级：Gemini 的 BeforeTool 没有 ask 决策，REVIEW 降级为
 * decision "allow" + systemMessage 警告（警告放行）。
 */
import type { Engine } from "../../src/engine/index.js";
import { evaluateHook } from "../core/hook.js";
import type { HostResponse } from "../core/types.js";

export function handlePayload(payload: unknown, engine: Engine): Promise<HostResponse> {
  return evaluateHook(payload, engine, { dialect: "gemini-cli" });
}
