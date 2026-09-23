/**
 * grok-build 适配器测试。payload 样例按 xai-org/grok-build 的真实序列化
 * （xai-grok-hooks/src/event.rs HookEventEnvelope::to_hook_json：camelCase
 * 字段 + SNAKE_CASE_ALIASES 别名双写，hook_event_name 强制为 PascalCase）；
 * 响应契约 runner/mod.rs DecisionToken + runner/command.rs
 * parse_blocking_result（exit 2 = 阻断，stdout 的 allow/ask 在 exit 2 时
 * 被压成 deny）。引擎为真实 createEngine + 仓库内置 rules/ 与
 * policies/default.yaml。
 */
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Engine } from "../../src/engine/index.js";
import { detectDialect } from "../core/dialect.js";
import { normalizePayload } from "../core/normalize.js";
import { createTestEngine } from "../core/testing.js";
import type { HostResponse } from "../core/types.js";
import { handlePayload } from "./hook.js";

let engine: Engine;
let dir: string;
beforeAll(() => {
  const handle = createTestEngine();
  engine = handle.engine;
  dir = handle.dir;
});
afterAll(async () => {
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 与宿主 to_hook_json 输出同形的 PreToolUse envelope（双写别名全带） */
const BASE = {
  hookEventName: "pre_tool_use",
  hook_event_name: "PreToolUse",
  sessionId: "sess-grok-build-1",
  session_id: "sess-grok-build-1",
  cwd: "/repo",
  workspaceRoot: "/repo",
  permissionMode: "default",
  promptId: "turn-7",
  timestamp: "2026-09-23T12:00:00Z",
  toolUseId: "call_1",
  toolInputTruncated: false,
};

function toolPayload(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...BASE,
    toolName,
    tool_name: toolName,
    toolInput: input,
    tool_input: input,
  };
}

function shellPayload(command: string): Record<string, unknown> {
  return toolPayload("run_terminal_command", { command });
}

function parseStdout(result: HostResponse): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("grok-build 方言识别（camelCase hookEventName 特征）", () => {
  it("带 timestamp 的 grok-build payload 不误判 copilot", () => {
    expect(detectDialect(shellPayload("ls"))).toBe("grok-build");
  });
});

describe("grok-build 归一化（camelCase + snake_case 别名双写）", () => {
  it("PreToolUse payload → ToolCall（run_terminal_command 归类 shell）", () => {
    const { dialect, event, call } = normalizePayload(shellPayload("ls -la"), "grok-build");
    expect(dialect).toBe("grok-build");
    expect(event).toBe("PreToolUse");
    expect(call.agent_id).toBe("grok-build");
    expect(call.session_id).toBe("sess-grok-build-1");
    expect(call.run_id).toBe("turn-7");
    expect(call.tool).toEqual({
      name: "run_terminal_command",
      action: "execute",
      category: "shell",
    });
    expect(call.input).toEqual({ command: "ls -la" });
    expect(call.context).toEqual({ cwd: "/repo" });
  });

  it("只有 snake_case 事件值（hookEventName: pre_tool_use）也接受", () => {
    const payload = shellPayload("ls");
    delete payload.hook_event_name;
    const { event, call } = normalizePayload(payload, "grok-build");
    expect(event).toBe("PreToolUse");
    expect(call.tool.category).toBe("shell");
  });

  it("search_replace 归类 filesystem write", () => {
    const { call } = normalizePayload(
      toolPayload("search_replace", { file_path: "/repo/a.ts", old_string: "a", new_string: "b" }),
      "grok-build",
    );
    expect(call.tool).toEqual({ name: "search_replace", action: "write", category: "filesystem" });
  });

  it("MCP 限定名 server__tool 归类 mcp", () => {
    const { call } = normalizePayload(
      toolPayload("linear__save_issue", { title: "x" }),
      "grok-build",
    );
    expect(call.tool).toEqual({ name: "linear__save_issue", action: "execute", category: "mcp" });
  });
});

describe("grok-build 回译（allow/ask/deny 三档；deny = exit 2 + stderr + JSON）", () => {
  it("rm -rf / → decision deny + exit 2 + stderr 原因", async () => {
    const result = await handlePayload(shellPayload("rm -rf /"), engine);
    expect(result.exitCode).toBe(2);
    expect(parseStdout(result)).toMatchObject({ decision: "deny" });
    expect(result.stderr).toContain("AgentFence DENY");
    expect(result.stderr).toContain("fs.rm-recursive-guarded-path");
  });

  it("git reset --hard → REVIEW 原生 ask（exit 0，无降级）", async () => {
    const result = await handlePayload(shellPayload("git reset --hard HEAD~1"), engine);
    expect(result.exitCode).toBe(0);
    const stdout = parseStdout(result);
    expect(stdout).toMatchObject({ decision: "ask" });
    expect(stdout.reason).toContain("git.reset-hard");
    expect(result.stderr).toBeUndefined();
  });

  it("ls -la → decision allow + exit 0", async () => {
    const result = await handlePayload(shellPayload("ls -la"), engine);
    expect(result.exitCode).toBe(0);
    expect(parseStdout(result)).toMatchObject({ decision: "allow" });
    expect(result.stderr).toBeUndefined();
  });

  it("PostToolUse 不是执行前点位 → 直通 allow", async () => {
    const result = await handlePayload(
      {
        ...shellPayload("ls"),
        hookEventName: "post_tool_use",
        hook_event_name: "PostToolUse",
      },
      engine,
    );
    expect(result.exitCode).toBe(0);
    expect(parseStdout(result)).toMatchObject({ decision: "allow" });
  });

  it("payload 非对象 → fail-closed deny + exit 2", async () => {
    const result = await handlePayload("not json", engine);
    expect(result.exitCode).toBe(2);
    expect(parseStdout(result)).toMatchObject({ decision: "deny" });
    expect(result.stderr).toContain("fail-closed");
  });

  it("缺 toolName → fail-closed deny + exit 2", async () => {
    const payload = shellPayload("ls");
    delete payload.toolName;
    delete payload.tool_name;
    const result = await handlePayload(payload, engine);
    expect(result.exitCode).toBe(2);
    expect(parseStdout(result)).toMatchObject({ decision: "deny" });
  });
});
