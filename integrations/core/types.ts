/**
 * 适配层共享类型：宿主方言、归一化结果、宿主响应。
 * 方言细节（事件名 / payload 字段 / 响应形状）的调研依据：
 * docs/research/jev-guard.md "Tool Call 数据结构" 一节。
 */
import type { ToolCall } from "../../src/api/types.js";

/** 五家宿主方言标识（同时用作 ToolCall.agent_id） */
export type HostDialect = "claude-code" | "codex" | "gemini-cli" | "cursor" | "opencode";

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
 * 全部宿主一律 exit 0 用 JSON 表达判定（现代 hook 契约）；
 * 非 0 只留给进程级崩溃（宿主按自身语义处理非零退出）。
 */
export interface HostResponse {
  stdout: string;
  exitCode: number;
}
