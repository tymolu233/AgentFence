/**
 * grok-cli 适配器测试。payload 样例按 superagent-ai/grok-cli 的
 * PreToolUseHookInput（src/hooks/types.ts:35-39：
 * {hook_event_name, tool_name, tool_input, session_id?, cwd}；
 * 响应契约 HookOutput + exit 2 = 阻断，executor.ts:5,64-77）。
 * 引擎为真实 createEngine + 仓库内置 rules/ 与 policies/default.yaml。
 */
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Engine } from "../../src/engine/index.js";
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
  session_id: "sess-grok-1",
  cwd: "/repo",
};

function bashPayload(command: string): Record<string, unknown> {
  return { ...BASE, tool_name: "bash", tool_input: { command } };
}

function parseStdout(result: HostResponse): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("grok-cli 归一化（Claude 同形 payload）", () => {
  it("PreToolUse payload → ToolCall（bash 归类 shell）", () => {
    const { dialect, event, call } = normalizePayload(bashPayload("ls -la"), "grok-cli");
    expect(dialect).toBe("grok-cli");
    expect(event).toBe("PreToolUse");
    expect(call.agent_id).toBe("grok-cli");
    expect(call.session_id).toBe("sess-grok-1");
    expect(call.tool).toEqual({ name: "bash", action: "execute", category: "shell" });
    expect(call.input).toEqual({ command: "ls -la" });
    expect(call.context).toEqual({ cwd: "/repo" });
  });
});

describe("grok-cli 回译（approve/block 两档；block = exit 2 + stderr）", () => {
  it("rm -rf / → decision block + exit 2 + stderr 原因", async () => {
    const result = await handlePayload(bashPayload("rm -rf /"), engine);
    expect(result.exitCode).toBe(2);
    expect(parseStdout(result)).toMatchObject({ decision: "block" });
    expect(result.stderr).toContain("AgentFence DENY");
    expect(result.stderr).toContain("fs.rm-recursive-guarded-path");
  });

  it("git reset --hard → REVIEW 降级 block（无 ask 档），消息与 DENY 区分", async () => {
    const result = await handlePayload(bashPayload("git reset --hard HEAD~1"), engine);
    expect(result.exitCode).toBe(2);
    expect(parseStdout(result)).toMatchObject({ decision: "block" });
    expect(result.stderr).toContain("AgentFence REVIEW 降级阻断");
    expect(result.stderr).toContain("git.reset-hard");
  });

  it("ls -la → decision approve + exit 0", async () => {
    const result = await handlePayload(bashPayload("ls -la"), engine);
    expect(result.exitCode).toBe(0);
    expect(parseStdout(result)).toMatchObject({ decision: "approve" });
    expect(result.stderr).toBeUndefined();
  });

  it("PostToolUse 不是执行前点位 → 直通 approve", async () => {
    const result = await handlePayload(
      { ...BASE, hook_event_name: "PostToolUse", tool_name: "bash", tool_input: {} },
      engine,
    );
    expect(result.exitCode).toBe(0);
    expect(parseStdout(result)).toMatchObject({ decision: "approve" });
  });

  it("payload 非对象 → fail-closed block + exit 2", async () => {
    const result = await handlePayload("not json", engine);
    expect(result.exitCode).toBe(2);
    expect(parseStdout(result)).toMatchObject({ decision: "block" });
    expect(result.stderr).toContain("fail-closed");
  });
});
