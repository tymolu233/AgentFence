/**
 * Claude Code 适配器测试。
 * payload 样例按调研报告记录的 Claude Code PreToolUse 真实形状
 * （PascalCase 事件 + session_id/transcript_path/cwd/tool_name/tool_input，
 * docs/research/jev-guard.md src/hook.js:11-16 段）。
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
  session_id: "sess-claude-1",
  transcript_path: "/home/u/.claude/projects/proj/sess-claude-1.jsonl",
  cwd: "/repo",
};

function bashPayload(command: string): Record<string, unknown> {
  return {
    ...BASE,
    tool_name: "Bash",
    tool_input: { command, description: `run: ${command}` },
  };
}

function parseStdout(result: HostResponse): unknown {
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

describe("claude-code 归一化", () => {
  it("PreToolUse payload → ToolCall（保留宿主工具名，Bash 归类 shell）", () => {
    const { dialect, event, call } = normalizePayload(bashPayload("ls -la"), "claude-code");
    expect(dialect).toBe("claude-code");
    expect(event).toBe("PreToolUse");
    expect(call.agent_id).toBe("claude-code");
    expect(call.session_id).toBe("sess-claude-1");
    expect(call.tool).toEqual({ name: "Bash", action: "execute", category: "shell" });
    expect(call.input).toMatchObject({ command: "ls -la" });
    expect(call.context).toEqual({ cwd: "/repo" });
    expect(call.request_id).toBeTruthy();
  });

  it("方言识别：无 turn_id/model 的 PreToolUse 是 claude-code，有的是 codex", () => {
    expect(detectDialect(bashPayload("ls"))).toBe("claude-code");
    expect(detectDialect({ ...bashPayload("ls"), turn_id: "t-1", model: "gpt" })).toBe("codex");
  });
});

describe("claude-code 回译（permissionDecision 三档齐全，无降级）", () => {
  it("rm -rf / → deny，命中 fs.rm-recursive-guarded-path", async () => {
    const result = await handlePayload(bashPayload("rm -rf /"), engine);
    expect(parseStdout(result)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
    expect(result.stdout).toContain("fs.rm-recursive-guarded-path");
  });

  it("git reset --hard → REVIEW 原生映射 ask", async () => {
    const result = await handlePayload(bashPayload("git reset --hard HEAD~1"), engine);
    expect(parseStdout(result)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "ask" },
    });
    expect(result.stdout).toContain("git.reset-hard");
  });

  it("ls -la → allow", async () => {
    const result = await handlePayload(bashPayload("ls -la"), engine);
    expect(parseStdout(result)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
  });

  it("Read 工具（action=read）→ allow", async () => {
    const result = await handlePayload(
      { ...BASE, tool_name: "Read", tool_input: { file_path: "/repo/README.md" } },
      engine,
    );
    expect(parseStdout(result)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
  });

  it("PostToolUse 不是执行前点位 → 直通 allow", async () => {
    const result = await handlePayload(
      { ...BASE, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {} },
      engine,
    );
    expect(parseStdout(result)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
  });

  it("payload 非对象 → fail-closed deny", async () => {
    const result = await handlePayload("not a json object", engine);
    expect(parseStdout(result)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(result.stdout).toContain("fail-closed");
  });
});
