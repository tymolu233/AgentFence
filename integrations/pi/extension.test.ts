/**
 * pi 扩展测试：tool_call 事件形状按调研报告 extensions/jev-guard.ts:14-28 段
 * （event.toolName + event.input；ctx.hasUI / ctx.ui.confirm 审批；返回
 * { block: true, reason } 阻断、undefined 放行；无 UI 时 ask 直接 block）。
 * 引擎为真实 createEngine + 仓库内置 rules/ 与 policies/default.yaml；
 * 仅宿主 UI（ctx.ui.confirm）用桩实现 —— 判定层零 mock。
 */
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Engine } from "../../src/engine/index.js";
import { normalizePiCall } from "../core/normalize.js";
import { createTestEngine } from "../core/testing.js";
import { createToolCallHandler, type PiContext, type PiToolCallHandler } from "./extension.js";

let engine: Engine;
let dir: string;
let handler: PiToolCallHandler;
beforeAll(() => {
  const handle = createTestEngine();
  engine = handle.engine;
  dir = handle.dir;
  handler = createToolCallHandler(engine);
});
afterAll(async () => {
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

function ctxWithUi(approved: boolean, calls: string[] = []): PiContext {
  return {
    cwd: "/repo",
    hasUI: true,
    ui: {
      confirm: (title: string, message: string) => {
        calls.push(`${title} | ${message}`);
        return Promise.resolve(approved);
      },
      notify: () => undefined,
    },
    sessionManager: { getSessionId: () => "sess-pi-1" },
  };
}

const NO_UI: PiContext = { cwd: "/repo", hasUI: false };

describe("pi 归一化（event.toolName + event.input）", () => {
  it("bash 归类 shell，cwd/sessionId 进 context/session_id", () => {
    const call = normalizePiCall("bash", { command: "ls" }, { cwd: "/repo", sessionId: "sess-pi-1" });
    expect(call.agent_id).toBe("pi");
    expect(call.session_id).toBe("sess-pi-1");
    expect(call.tool).toEqual({ name: "bash", action: "execute", category: "shell" });
    expect(call.input).toEqual({ command: "ls" });
    expect(call.context).toEqual({ cwd: "/repo" });
  });

  it("input 非对象 → NormalizeError（上层 fail-closed block）", () => {
    expect(() => normalizePiCall("bash", "ls")).toThrow(/input 必须是对象/);
  });
});

describe("pi tool_call 三态", () => {
  it("rm -rf / → block（AgentFence DENY，命中 fs.rm-recursive-guarded-path）", async () => {
    const result = await handler(
      { toolName: "bash", input: { command: "rm -rf /" } },
      ctxWithUi(true),
    );
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("AgentFence DENY");
    expect(result?.reason).toContain("fs.rm-recursive-guarded-path");
  });

  it("ls -la → 放行（undefined）", async () => {
    await expect(
      handler({ toolName: "bash", input: { command: "ls -la" } }, NO_UI),
    ).resolves.toBeUndefined();
  });

  it("write 工具（action=write）→ 放行（policy 默认）", async () => {
    await expect(
      handler({ toolName: "write", input: { path: "src/a.ts", content: "x" } }, NO_UI),
    ).resolves.toBeUndefined();
  });
});

describe("pi REVIEW：有 UI 弹 confirm，无 UI 直接 block", () => {
  const REVIEW_EVENT = { toolName: "bash", input: { command: "git reset --hard HEAD~1" } };

  it("有 UI 且用户批准 → 放行，confirm 被调用一次", async () => {
    const calls: string[] = [];
    const result = await handler(REVIEW_EVENT, ctxWithUi(true, calls));
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("git.reset-hard");
  });

  it("有 UI 但用户拒绝 → block（User rejected）", async () => {
    const result = await handler(REVIEW_EVENT, ctxWithUi(false));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("User rejected");
  });

  it("无 UI（hasUI=false）→ REVIEW 降级 block，不弹确认", async () => {
    const result = await handler(REVIEW_EVENT, NO_UI);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("AgentFence REVIEW 降级阻断");
    expect(result?.reason).toContain("git.reset-hard");
  });

  it("hasUI=true 但 ui 缺失 → 同样降级 block（不信任自报）", async () => {
    const result = await handler(REVIEW_EVENT, { hasUI: true });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("REVIEW 降级阻断");
  });
});

describe("pi fail-closed", () => {
  it("toolName 缺失 → block（不送引擎）", async () => {
    const result = await handler({ input: { command: "ls" } }, NO_UI);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("fail-closed");
  });

  it("input 是字符串 → block（不送引擎）", async () => {
    const result = await handler({ toolName: "bash", input: "ls" }, NO_UI);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("fail-closed");
  });
});
