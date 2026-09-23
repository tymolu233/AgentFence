/**
 * 方言识别：从 hook payload 判断宿主是哪家。
 *
 * 依据 docs/research/jev-guard.md "Tool Call 数据结构" 一节：
 * - Claude Code / Codex / Copilot 同为 PascalCase 事件 + tool_name/tool_input
 *   对象：Codex 多 turn_id + model，Copilot 多 ISO timestamp（且无 turn_id，
 *   调研报告 src/hook.js:11-16 段 detectAgent），Claude Code 两者皆无；
 * - Gemini CLI 用 BeforeTool / AfterTool / BeforeAgent 事件名；
 * - Cursor 用 camelCase 事件，且可靠字段区分（beforeShellExecution 只有
 *   command+cwd；beforeMCPExecution 带 mcp_server_name；preToolUse 的
 *   tool_input 是字符串而非对象）。
 * - grok-build（xAI 官方 Rust 版）双写事件键：camelCase `hookEventName`
 *   带 snake_case 值（"pre_tool_use"）+ snake_case `hook_event_name` 带
 *   PascalCase 值（"PreToolUse"），字段为 camelCase（toolName/toolInput/
 *   sessionId）并附 snake_case 别名（xai-grok-hooks/src/event.rs
 *   HookEventEnvelope::to_hook_json）。它同时带 timestamp，若按 Claude 形
 *   分支走会被误判为 copilot —— 故 camelCase `hookEventName` 特征最先判。
 *
 * 各宿主入口（integrations/<host>/index.ts）按安装点位钉死方言，
 * 本函数是通用入口 / 误装兜底；识别不出返回 undefined（上层 fail-closed）。
 */
import { asString } from "./payload.js";
import type { HostDialect } from "./types.js";

const GEMINI_EVENTS = new Set(["BeforeTool", "AfterTool", "BeforeAgent"]);
const CURSOR_EVENTS = new Set(["beforeShellExecution", "beforeMCPExecution", "preToolUse"]);

export function detectDialect(payload: Record<string, unknown>): HostDialect | undefined {
  // grok-build 独有特征：camelCase hookEventName 键（其余宿主只有 snake_case
  // hook_event_name 或自家事件名）。必须先于 PreToolUse 分支判断 —— grok-build
  // 双写 hook_event_name: "PreToolUse" 且带 timestamp，落进 Claude 形分支会被
  // 误判为 copilot。
  if (asString(payload.hookEventName) !== undefined) return "grok-build";

  const event = asString(payload.hook_event_name);

  if (event === "PreToolUse") {
    // 三家 Claude 形 payload 的区分顺序同调研报告 detectAgent：
    // Copilot 先看（timestamp 且非 Codex），再 Codex（turn_id + model），兜底 Claude
    if (asString(payload.timestamp) !== undefined && asString(payload.turn_id) === undefined) {
      return "copilot";
    }
    if (asString(payload.turn_id) !== undefined && asString(payload.model) !== undefined) {
      return "codex";
    }
    return "claude-code";
  }
  if (event !== undefined && GEMINI_EVENTS.has(event)) return "gemini-cli";
  if (event !== undefined && CURSOR_EVENTS.has(event)) return "cursor";

  // 无 hook_event_name 的字段回退（Cursor 三事件的字段互斥）
  if (asString(payload.mcp_server_name) !== undefined) return "cursor";
  if (asString(payload.command) !== undefined && payload.tool_name === undefined) {
    return "cursor";
  }
  if (typeof payload.tool_input === "string") return "cursor";
  return undefined;
}
