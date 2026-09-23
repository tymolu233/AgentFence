/**
 * OpenCode 插件测试：进程内插件形态（docs/research/jev-guard.md
 * src/opencode.js:25-39 段：tool.execute.before 的 input.tool + output.args；
 * permission.ask 从 metadata/pattern/title 重建参数映射 output.status）。
 * 引擎为真实 createEngine + 仓库内置 rules/ 与 policies/default.yaml。
 */
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Engine } from "../../src/engine/index.js";
import { normalizeOpenCodeCall } from "../core/normalize.js";
import { createTestEngine } from "../core/testing.js";
import {
  AgentFenceBlockError,
  createAgentFenceHooks,
  type OpenCodeHooks,
} from "./plugin.js";

let engine: Engine;
let dir: string;
let hooks: OpenCodeHooks;
beforeAll(() => {
  const handle = createTestEngine();
  engine = handle.engine;
  dir = handle.dir;
  hooks = createAgentFenceHooks(engine);
});
afterAll(async () => {
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

function beforeInput(tool: string) {
  return { tool, sessionID: "sess-oc-1", callID: "call-1" };
}

describe("opencode 归一化（input.tool + output.args）", () => {
  it("bash 归类 shell，sessionID/callID 进 session_id/run_id", () => {
    const call = normalizeOpenCodeCall("bash", { command: "ls" }, {
      sessionID: "sess-oc-1",
      callID: "call-1",
    });
    expect(call.agent_id).toBe("opencode");
    expect(call.session_id).toBe("sess-oc-1");
    expect(call.run_id).toBe("call-1");
    expect(call.tool).toEqual({ name: "bash", action: "execute", category: "shell" });
    expect(call.input).toEqual({ command: "ls" });
  });
});

describe("opencode tool.execute.before（无 ask：REVIEW 降级为 throw 阻断）", () => {
  it("rm -rf / → throw AgentFenceBlockError（DENY）", async () => {
    await expect(
      hooks["tool.execute.before"](beforeInput("bash"), { args: { command: "rm -rf /" } }),
    ).rejects.toThrow(AgentFenceBlockError);
    await expect(
      hooks["tool.execute.before"](beforeInput("bash"), { args: { command: "rm -rf /" } }),
    ).rejects.toThrow(/AgentFence DENY/);
  });

  it("git reset --hard → REVIEW 降级阻断，消息与 DENY 区分", async () => {
    await expect(
      hooks["tool.execute.before"](beforeInput("bash"), {
        args: { command: "git reset --hard HEAD~1" },
      }),
    ).rejects.toThrow(/AgentFence REVIEW 降级阻断/);
  });

  it("ls → 放行（resolve，无告警副作用）", async () => {
    await expect(
      hooks["tool.execute.before"](beforeInput("bash"), { args: { command: "ls -la" } }),
    ).resolves.toBeUndefined();
  });

  it("read 工具 → 放行（policy.read.recon）", async () => {
    await expect(
      hooks["tool.execute.before"](beforeInput("read"), { args: { file_path: "a.ts" } }),
    ).resolves.toBeUndefined();
  });
});

describe("opencode permission.ask（原生 ask 通道，REVIEW 不降级）", () => {
  it("metadata.command 命中 DENY → status deny", async () => {
    const output = { status: "ask" as const };
    await hooks["permission.ask"](
      { permission: "bash", metadata: { command: "rm -rf /" }, title: "rm -rf /" },
      output,
    );
    expect(output.status).toBe("deny");
  });

  it("pattern 重建 command（git reset --hard）→ REVIEW → status ask", async () => {
    const output = { status: "allow" as const };
    await hooks["permission.ask"](
      { permission: "bash", pattern: "git reset --hard HEAD~1" },
      output,
    );
    expect(output.status).toBe("ask");
  });

  it("ls → status allow", async () => {
    const output = { status: "ask" as const };
    await hooks["permission.ask"]({ permission: "bash", pattern: "ls -la" }, output);
    expect(output.status).toBe("allow");
  });

  it("非 shell 权限（edit）→ status allow", async () => {
    const output = { status: "ask" as const };
    await hooks["permission.ask"](
      { permission: "edit", metadata: { file_path: "src/a.ts" } },
      output,
    );
    expect(output.status).toBe("allow");
  });
});
