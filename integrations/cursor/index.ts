/**
 * Cursor hook 入口：beforeShellExecution / beforeMCPExecution / preToolUse
 * 三个事件共用本入口（按 payload 字段自动分发）。安装见同目录 README.md。
 */
import { runHookEntry } from "../core/hook.js";

await runHookEntry("cursor");
