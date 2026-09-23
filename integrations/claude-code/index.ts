/**
 * Claude Code PreToolUse hook 入口。
 * 安装与 settings.json 配置片段见同目录 README.md。
 */
import { runHookEntry } from "../core/hook.js";

await runHookEntry("claude-code");
