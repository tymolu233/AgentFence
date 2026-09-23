/**
 * grok-cli 适配器：PreToolUse hook（调研结论见同目录 README.md；
 * 挂接点为 superagent-ai/grok-cli src/hooks/，xai-org/grok-cli 已下架）。
 *
 * payload 与 Claude Code 完全同形（PascalCase 事件 + tool_name/tool_input
 * 对象，src/hooks/types.ts PreToolUseHookInput）：
 *   { hook_event_name: "PreToolUse", tool_name, tool_input: {...},
 *     session_id?, cwd }
 *
 * 响应（src/hooks/types.ts HookOutput + executor.ts 退出码语义）：
 *   { decision: "approve"|"block", reason? } 写 stdout；
 *   exit 0 = 放行，exit 2 = 阻断。阻断原因只有经 stderr 才会被宿主拼成
 *   [Hook blocked] <stderr> 给 agent 看（src/grok/tools.ts:108-111）。
 *
 * 降级：hook 输出只有 approve/block 两档（无 ask），且 additionalContext /
 * reason 字段当前无人消费（无警告通道）—— REVIEW 按 fail-closed 降级为
 * block（与 opencode tool.execute.before 同族，消息区分 DENY 与 REVIEW）。
 */
import type { Engine } from "../../src/engine/index.js";
import { evaluateHook } from "../core/hook.js";
import type { HostResponse } from "../core/types.js";

export function handlePayload(payload: unknown, engine: Engine): Promise<HostResponse> {
  return evaluateHook(payload, engine, { dialect: "grok-cli" });
}
