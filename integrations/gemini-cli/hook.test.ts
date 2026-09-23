/**
 * Gemini CLI 适配器测试。
 * payload 样例按调研报告：BeforeTool 事件，tool_name / tool_input 字段
 * （docs/research/jev-guard.md src/hook.js:101-111 段）。
 * 降级矩阵行为：无 ask → REVIEW 降级为 decision allow + systemMessage 警告。
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

const BASE = {
  hook_event_name: "BeforeTool",
  session_id: "sess-gemini-1",
  cwd: "/repo",
};

function shellPayload(command: string): Record<string, unknown> {
  return { ...BASE, tool_name: "run_shell_command", tool_input: { command } };
}

function parseStdout(result: HostResponse): unknown {
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

describe("gemini-cli 归一化", () => {
  it("run_shell_command 归类 shell；write_file 归类 filesystem/write", () => {
    const shell = normalizePayload(shellPayload("ls"), "gemini-cli");
    expect(shell.dialect).toBe("gemini-cli");
    expect(shell.event).toBe("BeforeTool");
    expect(shell.call.tool).toEqual({
      name: "run_shell_command",
      action: "execute",
      category: "shell",
    });

    const write = normalizePayload(
      { ...BASE, tool_name: "write_file", tool_input: { file_path: "/repo/a.txt", content: "x" } },
      "gemini-cli",
    );
    expect(write.call.tool).toEqual({
      name: "write_file",
      action: "write",
      category: "filesystem",
    });
  });

  it("方言识别：BeforeTool/AfterTool/BeforeAgent → gemini-cli", () => {
    expect(detectDialect(shellPayload("ls"))).toBe("gemini-cli");
    expect(detectDialect({ hook_event_name: "AfterTool", tool_name: "x" })).toBe("gemini-cli");
    expect(detectDialect({ hook_event_name: "BeforeAgent" })).toBe("gemini-cli");
  });
});

describe("gemini-cli 降级矩阵（无 ask：REVIEW → 警告放行）", () => {
  it("git reset --hard（REVIEW）→ decision allow + systemMessage 警告", async () => {
    const result = await handlePayload(shellPayload("git reset --hard HEAD~1"), engine);
    expect(parseStdout(result)).toMatchObject({ decision: "allow" });
    expect(result.stdout).toContain("systemMessage");
    expect(result.stdout).toContain("REVIEW 降级放行");
  });

  it("rm -rf / → decision deny + reason", async () => {
    const result = await handlePayload(shellPayload("rm -rf /"), engine);
    expect(parseStdout(result)).toMatchObject({ decision: "deny" });
    expect(result.stdout).toContain("fs.rm-recursive-guarded-path");
  });

  it("ls → decision allow，无警告", async () => {
    const result = await handlePayload(shellPayload("ls"), engine);
    expect(parseStdout(result)).toMatchObject({ decision: "allow" });
    expect(result.stdout).not.toContain("systemMessage");
  });

  it("write_file（无规则命中、policy 无意见）→ decision allow", async () => {
    const result = await handlePayload(
      { ...BASE, tool_name: "write_file", tool_input: { file_path: "/repo/a.txt", content: "x" } },
      engine,
    );
    expect(parseStdout(result)).toMatchObject({ decision: "allow" });
  });

  it("AfterTool 不是执行前点位 → 直通 allow", async () => {
    const result = await handlePayload(
      { hook_event_name: "AfterTool", tool_name: "run_shell_command", tool_input: {} },
      engine,
    );
    expect(parseStdout(result)).toMatchObject({ decision: "allow" });
  });
});
