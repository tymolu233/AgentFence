/**
 * 宿主工具名 → 统一 ToolRef 的映射。
 *
 * 判定层只认结构化 category（engine 的 parser 层与 rules 的 match.tool
 * 都路由在 name/category 上，见 src/engine/engine.ts isShellTool 与
 * src/rules/matcher.ts matchToolField），因此这里保留宿主原始工具名
 * （审计可读），把语义归类放进 category：
 *
 *   shell      → category "shell"（触发 parser 层 + rules shell 类目）
 *   写文件类   → category "filesystem"，action "write"
 *   读文件类   → category "filesystem"，action "read"
 *   其余       → 不设 category，action "execute"（落到 policy / 默认 ALLOW）
 *
 * 名字表按各宿主文档的内置工具命名收录（小写比较）：
 * Claude Code(Bash/Read/Write/Edit/NotebookEdit)、Codex(shell/apply_patch)、
 * Gemini CLI(run_shell_command/read_file/write_file/replace)、
 * OpenCode(bash/read/edit/write)、Cursor(Write/Edit 等，经 preToolUse)。
 */
import type { ToolRef } from "../../src/api/types.js";

const SHELL_TOOLS = new Set([
  "bash",
  "shell",
  "run_shell_command",
  "terminal",
  "console",
  "local_shell",
]);

const FS_WRITE_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "apply_patch",
  "write_file",
  "replace",
  "str_replace_editor",
  "str_replace_based_edit_tool",
]);

const FS_READ_TOOLS = new Set(["read", "read_file", "view"]);

export function toToolRef(hostToolName: string): ToolRef {
  const key = hostToolName.toLowerCase();
  if (SHELL_TOOLS.has(key)) {
    return { name: hostToolName, action: "execute", category: "shell" };
  }
  if (FS_WRITE_TOOLS.has(key)) {
    return { name: hostToolName, action: "write", category: "filesystem" };
  }
  if (FS_READ_TOOLS.has(key)) {
    return { name: hostToolName, action: "read", category: "filesystem" };
  }
  return { name: hostToolName, action: "execute" };
}
