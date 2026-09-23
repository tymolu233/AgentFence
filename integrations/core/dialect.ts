/**
 * 方言识别：从 hook payload 判断宿主是哪家。
 *
 * 依据 docs/research/jev-guard.md "Tool Call 数据结构" 一节：
 * - Claude Code / Codex 同为 PascalCase 事件 + tool_name/tool_input 对象，
 *   Codex 多 turn_id + model（Copilot 多 ISO timestamp，不在本期五家范围）；
 * - Gemini CLI 用 BeforeTool / AfterTool / BeforeAgent 事件名；
 * - Cursor 用 camelCase 事件，且可靠字段区分（beforeShellExecution 只有
 *   command+cwd；beforeMCPExecution 带 mcp_server_name；preToolUse 的
 *   tool_input 是字符串而非对象）。
 *
 * 各宿主入口（integrations/<host>/index.ts）按安装点位钉死方言，
 * 本函数是通用入口 / 误装兜底；识别不出返回 undefined（上层 fail-closed）。
 */
import { asString } from "./payload.js";
import type { HostDialect } from "./types.js";

const GEMINI_EVENTS = new Set(["BeforeTool", "AfterTool", "BeforeAgent"]);
const CURSOR_EVENTS = new Set(["beforeShellExecution", "beforeMCPExecution", "preToolUse"]);

export function detectDialect(payload: Record<string, unknown>): HostDialect | undefined {
  const event = asString(payload.hook_event_name);

  if (event === "PreToolUse") {
    // Codex 与 Claude Code 同形，靠 turn_id + model 区分（调研报告 src/hook.js:11-16 段）
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
