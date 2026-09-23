/**
 * grok-build 适配器：PreToolUse hook（调研结论见同目录 README.md；
 * 挂接点为 xai-org/grok-build 的 xai-grok-hooks crate，Claude Code 风格）。
 *
 * payload（camelCase 字段 + snake_case 别名双写，event.rs to_hook_json）：
 *   { hookEventName: "pre_tool_use", hook_event_name: "PreToolUse",
 *     sessionId / session_id, cwd, workspaceRoot, permissionMode, promptId,
 *     toolName / tool_name, toolInput / tool_input, toolUseId,
 *     toolInputTruncated, timestamp }
 *
 * 响应（runner/mod.rs DecisionToken + runner/command.rs parse_blocking_result）：
 *   { decision: "allow"|"ask"|"deny", reason? } 写 stdout。
 *   三档齐全，REVIEW 原生映射 ask（进宿主权限提示，无降级）。
 *   allow/ask 必须 exit 0（exit 2 会把 stdout 的 allow/ask 压成 deny）；
 *   deny 走 exit 2 + stderr + JSON 三写 —— 宿主对 hook 失败一律 fail-open，
 *   exit 2 是唯一不依赖 stdout JSON 的阻断通道。
 *
 * 覆盖面：PreToolUse 在工具分派主路径触发（xai-grok-shell
 * acp_session_impl/tool_calls.rs apply_pre_tool_use_gate），内置工具与
 * MCP（限定名 server__tool）全覆盖 —— 与 grok-cli 只接 bash 不同。
 */
import type { Engine } from "../../src/engine/index.js";
import { evaluateHook } from "../core/hook.js";
import type { HostResponse } from "../core/types.js";

export function handlePayload(payload: unknown, engine: Engine): Promise<HostResponse> {
  return evaluateHook(payload, engine, { dialect: "grok-build" });
}
