/**
 * 适配层共享类型：宿主方言、归一化结果、宿主响应。
 * 方言细节（事件名 / payload 字段 / 响应形状）的调研依据：
 * docs/research/jev-guard.md "Tool Call 数据结构" 一节。
 */
import type { ToolCall } from "../../src/api/types.js";

/** 宿主方言标识（同时用作 ToolCall.agent_id） */
export type HostDialect =
  | "claude-code"
  | "codex"
  | "gemini-cli"
  | "cursor"
  | "opencode"
  | "copilot"
  | "pi"
  | "acp"
  | "grok-build";

/**
 * stdin/stdout 命令 hook 形态的方言子集（runHookEntry 的合法入参）。
 * opencode / pi 是进程内插件，acp 是 JSON-RPC stdio 代理，均无此入口。
 */
export type StdioDialect = Exclude<HostDialect, "opencode" | "pi" | "acp">;

/** Cursor 三个 pre-tool-use 事件（camelCase，见调研报告 src/hook.js:115-123 段） */
export type CursorEvent = "beforeShellExecution" | "beforeMCPExecution" | "preToolUse";

/** 归一化产物：方言 + 事件名 + 统一判定输入 */
export interface NormalizedHook {
  dialect: HostDialect;
  /** 宿主原始事件名（PreToolUse / BeforeTool / beforeShellExecution / ...） */
  event: string;
  call: ToolCall;
}

/**
 * 宿主响应：写 stdout 的 JSON 文本 + 进程退出码。
 * 除 grok-build 的 DENY 外一律 exit 0 用 JSON 表达判定（现代 hook 契约）；
 * 非 0 只留给进程级崩溃（宿主按自身语义处理非零退出）。
 * grok-build 例外：其 hook 契约里 exit 2 = 显式阻断（宿主 fail-open，
 * 唯一不依赖 stdout JSON 的阻断信号），故 DENY 走 exit 2 + stderr +
 * stdout JSON 三写双保险（xai-org/grok-build xai-grok-hooks/src/runner/
 * command.rs parse_blocking_result），stderr 字段专为它保留。
 */
export interface HostResponse {
  stdout: string;
  exitCode: number;
  /** grok-build 阻断原因经 stderr 兜底（stdout JSON 损坏时仍阻断）；其余宿主不设 */
  stderr?: string;
}
