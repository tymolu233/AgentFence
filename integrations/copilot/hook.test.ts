/**
 * Copilot CLI 适配器测试。
 * payload 样例按调研报告记录的 Copilot CLI PreToolUse 真实形状
 * （Claude Code 同形 + 额外 ISO timestamp 字段，无 turn_id/model，
 * docs/research/jev-guard.md src/hook.js:11-16 段 detectAgent）。
 * 引擎为真实 createEngine + 仓库内置 rules/ 与 policies/default.yaml。
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
  hook_event_name: "PreToolUse",
  session_id: "sess-copilot-1",
  cwd: "/repo",
  timestamp: "2026-09-23T08:15:30.123Z",
};

function bashPayload(command: string): Record<string, unknown> {
  return { ...BASE, tool_name: "bash", tool_input: { command } };
}

function parseStdout(result: HostResponse): Record<string, unknown> {
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("copilot 归一化", () => {
  it("PreToolUse payload → ToolCall（timestamp 仅为识别特征，不进 ToolCall）", () => {
    const { dialect, event, call } = normalizePayload(bashPayload("ls -la"), "copilot");
    expect(dialect).toBe("copilot");
    expect(event).toBe("PreToolUse");
    expect(call.agent_id).toBe("copilot");
    expect(call.session_id).toBe("sess-copilot-1");
    expect(call.tool).toEqual({ name: "bash", action: "execute", category: "shell" });
    expect(call.input).toEqual({ command: "ls -la" });
    expect(call.context).toEqual({ cwd: "/repo" });
    expect(JSON.stringify(call)).not.toContain("timestamp");
  });

  it("方言识别：timestamp 无 turn_id → copilot；turn_id+model → codex；皆无 → claude-code", () => {
    expect(detectDialect(bashPayload("ls"))).toBe("copilot");
    expect(
      detectDialect({ ...bashPayload("ls"), turn_id: "t-1", model: "gpt" }),
    ).toBe("codex");
    const noTs = { ...bashPayload("ls") };
    delete noTs.timestamp;
    expect(detectDialect(noTs)).toBe("claude-code");
    // jev-guard detectAgent 同款边界：turn_id 存在即不归 copilot
    expect(detectDialect({ ...bashPayload("ls"), turn_id: "t-1" })).toBe("claude-code");
  });
});

describe("copilot 回译（permissionDecision 顶层 + 信封双写，三档齐全）", () => {
  it("rm -rf / → deny，命中 fs.rm-recursive-guarded-path", async () => {
    const result = parseStdout(await handlePayload(bashPayload("rm -rf /"), engine));
    expect(result).toMatchObject({
      permissionDecision: "deny",
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    expect(JSON.stringify(result)).toContain("fs.rm-recursive-guarded-path");
  });

  it("git reset --hard → REVIEW 原生映射 ask（顶层与信封一致）", async () => {
    const result = parseStdout(await handlePayload(bashPayload("git reset --hard HEAD~1"), engine));
    expect(result).toMatchObject({
      permissionDecision: "ask",
      hookSpecificOutput: { permissionDecision: "ask" },
    });
    expect(JSON.stringify(result)).toContain("git.reset-hard");
  });

  it("ls -la → allow", async () => {
    const result = parseStdout(await handlePayload(bashPayload("ls -la"), engine));
    expect(result).toMatchObject({
      permissionDecision: "allow",
      hookSpecificOutput: { permissionDecision: "allow" },
    });
  });

  it("PostToolUse 不是执行前点位 → 直通 allow（双写形状保持）", async () => {
    const result = parseStdout(
      await handlePayload(
        { ...BASE, hook_event_name: "PostToolUse", tool_name: "bash", tool_input: {} },
        engine,
      ),
    );
    expect(result).toMatchObject({
      permissionDecision: "allow",
      hookSpecificOutput: { permissionDecision: "allow" },
    });
  });

  it("payload 非对象 → fail-closed deny（双写形状保持）", async () => {
    const result = parseStdout(await handlePayload(42, engine));
    expect(result).toMatchObject({
      permissionDecision: "deny",
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(JSON.stringify(result)).toContain("fail-closed");
  });
});
