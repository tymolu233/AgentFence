/**
 * 共享归一层测试：方言识别表 + evaluateHook 的 fail-closed 路径。
 * 各宿主的归一化/回译细节见对应适配器目录的测试。
 */
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Engine } from "../../src/engine/index.js";
import { detectDialect } from "./dialect.js";
import { evaluateHook } from "./hook.js";
import { createTestEngine } from "./testing.js";

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

describe("detectDialect 方言识别", () => {
  it("五家特征 payload 各归各家", () => {
    expect(
      detectDialect({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }),
    ).toBe("claude-code");
    expect(
      detectDialect({
        hook_event_name: "PreToolUse",
        tool_name: "shell",
        tool_input: {},
        turn_id: "t-1",
        model: "gpt",
      }),
    ).toBe("codex");
    expect(detectDialect({ hook_event_name: "BeforeTool", tool_name: "x" })).toBe("gemini-cli");
    expect(detectDialect({ hook_event_name: "beforeShellExecution", command: "ls" })).toBe(
      "cursor",
    );
  });

  it("无任何特征 → undefined", () => {
    expect(detectDialect({ hello: "world" })).toBeUndefined();
    expect(detectDialect({})).toBeUndefined();
  });
});

describe("evaluateHook fail-closed", () => {
  it("方言不可识别 → 通用 deny 形状", async () => {
    const result = await evaluateHook({ hello: "world" }, engine);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: "deny" });
    expect(result.stdout).toContain("fail-closed");
  });

  it("payload 非对象 → deny", async () => {
    const result = await evaluateHook([1, 2, 3], engine);
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: "deny" });
  });

  it("归一化失败（缺 tool_name）→ 宿主形状 deny", async () => {
    const result = await evaluateHook(
      { hook_event_name: "PreToolUse", tool_input: {} },
      engine,
      { dialect: "claude-code" },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it("自动识别路径：不钉方言也能完成判定", async () => {
    const result = await evaluateHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "s-1",
        cwd: "/repo",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
      },
      engine,
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });
});
