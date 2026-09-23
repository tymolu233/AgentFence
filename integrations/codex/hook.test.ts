/**
 * Codex 适配器测试。
 * payload 样例按调研报告：与 Claude Code 同形（PascalCase），
 * 多 turn_id + model（docs/research/jev-guard.md src/hook.js:11-16 段）。
 * 降级矩阵行为：无 ask → REVIEW 降级为 allow + systemMessage 警告。
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

/** Codex 真实 payload 形状：Claude 风格 + turn_id + model */
const BASE = {
  hook_event_name: "PreToolUse",
  session_id: "sess-codex-1",
  turn_id: "turn-42",
  model: "gpt-5.3-codex",
  cwd: "/repo",
};

function shellPayload(command: string): Record<string, unknown> {
  return { ...BASE, tool_name: "shell", tool_input: { command } };
}

function parseStdout(result: HostResponse): unknown {
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

describe("codex 归一化", () => {
  it("payload → ToolCall：turn_id 进 run_id", () => {
    const { dialect, call } = normalizePayload(shellPayload("ls"), "codex");
    expect(dialect).toBe("codex");
    expect(call.agent_id).toBe("codex");
    expect(call.run_id).toBe("turn-42");
    expect(call.tool).toEqual({ name: "shell", action: "execute", category: "shell" });
  });

  it("方言识别：turn_id + model → codex", () => {
    expect(detectDialect(shellPayload("ls"))).toBe("codex");
  });
});

describe("codex 降级矩阵（无 ask：REVIEW → 警告放行）", () => {
  it("git reset --hard（REVIEW）→ allow + systemMessage 警告", async () => {
    const result = await handlePayload(shellPayload("git reset --hard HEAD~1"), engine);
    expect(parseStdout(result)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    expect(result.stdout).toContain("systemMessage");
    expect(result.stdout).toContain("REVIEW 降级放行");
    expect(result.stdout).toContain("git.reset-hard");
  });

  it("rm -rf / → deny（DENY 不降级）", async () => {
    const result = await handlePayload(shellPayload("rm -rf /"), engine);
    expect(parseStdout(result)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(result.stdout).not.toContain("systemMessage");
  });

  it("ls → allow，无警告", async () => {
    const result = await handlePayload(shellPayload("ls"), engine);
    expect(parseStdout(result)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    expect(result.stdout).not.toContain("systemMessage");
  });
});
