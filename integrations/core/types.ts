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
  | "grok-cli";

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
 * 除 grok-cli 外一律 exit 0 用 JSON 表达判定（现代 hook 契约）；
 * 非 0 只留给进程级崩溃（宿主按自身语义处理非零退出）。
 * grok-cli 例外：其 hook 契约以 exit 2 表阻断、stderr 文本才会被
 * 宿主拼给 agent（superagent-ai/grok-cli src/hooks/executor.ts:5,64-77 与
 * src/grok/tools.ts:108-111），故 stderr 字段专为它保留。
 */
export interface HostResponse {
  stdout: string;
  exitCode: number;
  /** grok-cli 阻断原因经 stderr 送达 agent；其余宿主不设 */
  stderr?: string;
}
