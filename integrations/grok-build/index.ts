/**
 * grok-build PreToolUse hook 入口。
 * 安装与 ~/.grok/hooks/*.json 配置片段见同目录 README.md。
 */
import { runHookEntry } from "../core/hook.js";

await runHookEntry("grok-build");
