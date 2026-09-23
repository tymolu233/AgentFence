/**
 * Cursor 适配器测试：三事件，payload 样例按调研报告的 camelCase 形状
 * （docs/research/jev-guard.md src/hook.js:115-123 段）：
 * - beforeShellExecution { command, cwd }
 * - beforeMCPExecution { mcp_server_name, tool_name }
 * - preToolUse { tool_name, tool_input（字符串，需二次 JSON.parse）, agent_message }
 * 降级矩阵行为：shell/MCP 事件有原生 ask；preToolUse 无 ask → 警告放行。
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

function shellEvent(command: string): Record<string, unknown> {
  return { hook_event_name: "beforeShellExecution", command, cwd: "/repo" };
}

function preToolUse(toolName: string, toolInput: unknown): Record<string, unknown> {
  return {
    hook_event_name: "preToolUse",
    tool_name: toolName,
    tool_input: JSON.stringify(toolInput),
    agent_message: "我接下来要执行这个操作来完成用户的要求",
    cwd: "/repo",
  };
}

function parseStdout(result: HostResponse): unknown {
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

describe("cursor 归一化", () => {
  it("beforeShellExecution → shell 调用，command 进 input", () => {
    const { event, call } = normalizePayload(shellEvent("ls"), "cursor");
    expect(event).toBe("beforeShellExecution");
    expect(call.agent_id).toBe("cursor");
    expect(call.tool).toEqual({ name: "shell", action: "execute", category: "shell" });
    expect(call.input).toEqual({ command: "ls" });
    expect(call.context).toEqual({ cwd: "/repo" });
  });

  it("beforeMCPExecution → 合成 mcp__<server>__<tool>", () => {
    const payload = {
      hook_event_name: "beforeMCPExecution",
      mcp_server_name: "github",
      tool_name: "create_issue",
      cwd: "/repo",
    };
    const { event, call } = normalizePayload(payload, "cursor");
    expect(event).toBe("beforeMCPExecution");
    expect(call.tool).toEqual({
      name: "mcp__github__create_issue",
      action: "execute",
      category: "mcp",
    });
  });

  it("preToolUse：tool_input 字符串二次解析；agent_message 不进 session.user_intent", () => {
    const { event, call } = normalizePayload(
      preToolUse("Write", { file_path: "/repo/a.txt", content: "hello" }),
      "cursor",
    );
    expect(event).toBe("preToolUse");
    expect(call.tool).toEqual({ name: "Write", action: "write", category: "filesystem" });
    expect(call.input).toEqual({ file_path: "/repo/a.txt", content: "hello" });
    // agent 自述意图 ≠ 用户发言（不变量 4 精神）：不得进判定上下文
    expect(call.session).toBeUndefined();
  });

  it("方言识别：camelCase 事件名与字段回退都指向 cursor", () => {
    expect(detectDialect(shellEvent("ls"))).toBe("cursor");
    expect(detectDialect({ command: "ls", cwd: "/repo" })).toBe("cursor");
    expect(detectDialect({ mcp_server_name: "github", tool_name: "x" })).toBe("cursor");
    expect(detectDialect({ tool_name: "Write", tool_input: "{}" })).toBe("cursor");
  });
});

describe("cursor 回译", () => {
  it("beforeShellExecution：rm -rf / → permission deny（带 agent_message）", async () => {
    const result = await handlePayload(shellEvent("rm -rf /"), engine);
    expect(parseStdout(result)).toMatchObject({ permission: "deny" });
    expect(result.stdout).toContain("agent_message");
    expect(result.stdout).toContain("fs.rm-recursive-guarded-path");
  });

  it("beforeShellExecution：git reset --hard → 原生 ask", async () => {
    const result = await handlePayload(shellEvent("git reset --hard HEAD~1"), engine);
    expect(parseStdout(result)).toMatchObject({ permission: "ask" });
    expect(result.stdout).toContain("git.reset-hard");
  });

  it("beforeShellExecution：ls → allow", async () => {
    const result = await handlePayload(shellEvent("ls"), engine);
    expect(parseStdout(result)).toMatchObject({ permission: "allow" });
  });

  it("beforeMCPExecution：无规则命中 → allow", async () => {
    const result = await handlePayload(
      {
        hook_event_name: "beforeMCPExecution",
        mcp_server_name: "github",
        tool_name: "create_issue",
        tool_input: { title: "bug" },
        cwd: "/repo",
      },
      engine,
    );
    expect(parseStdout(result)).toMatchObject({ permission: "allow" });
  });

  it("preToolUse：REVIEW 降级为 allow + user_message 警告（该事件无 ask）", async () => {
    const result = await handlePayload(
      preToolUse("Bash", { command: "git reset --hard HEAD~1" }),
      engine,
    );
    expect(parseStdout(result)).toMatchObject({ permission: "allow" });
    expect(result.stdout).toContain("user_message");
    expect(result.stdout).toContain("REVIEW 降级放行");
  });

  it("preToolUse：DENY 不降级 → permission deny", async () => {
    const result = await handlePayload(preToolUse("Bash", { command: "rm -rf /" }), engine);
    expect(parseStdout(result)).toMatchObject({ permission: "deny" });
  });

  it("preToolUse：tool_input 非法 JSON → fail-closed deny", async () => {
    const result = await handlePayload(
      {
        hook_event_name: "preToolUse",
        tool_name: "Bash",
        tool_input: "{not json",
        cwd: "/repo",
      },
      engine,
    );
    expect(parseStdout(result)).toMatchObject({ permission: "deny" });
    expect(result.stdout).toContain("fail-closed");
  });
});
