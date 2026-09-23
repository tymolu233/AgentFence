/**
 * 测试 fixture 构造器：把命令字符串切成 ParsedShell。
 * 注意：这不是 parser！只支持空白分词、单/双引号成组、&& || ; | 切段，
 * 不做 unquote/解转义/重定向/变量展开——真实词法分析由 src/parser 负责。
 * 规则 tests 样例按"parser 归一化之后"的形态书写，可直接过本构造器。
 */

import type { ParsedCommand, ParsedShell, ToolCall } from "../api/types.js";

const SEGMENT_SPLIT = /&&|\|\||[;|]/;
const TOKEN = /"([^"]*)"|'([^']*)'|(\S+)/g;

export function sh(command: string): ParsedShell {
  const commands: ParsedCommand[] = [];
  for (const segment of command.split(SEGMENT_SPLIT)) {
    const tokens: string[] = [];
    for (const m of segment.matchAll(TOKEN)) {
      tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
    }
    const [executable, ...args] = tokens;
    if (executable === undefined) continue;
    commands.push({ executable, args, redirects: {}, env: {}, indirect: false });
  }
  return { commands };
}

export function shellCall(command: string): ToolCall {
  return {
    request_id: "req_test",
    agent_id: "vitest",
    tool: { name: "shell", action: "execute", category: "shell" },
    input: { command },
  };
}
