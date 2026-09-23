/**
 * ACP 代理测试。消息形状按调研报告 src/acp.js 与 ACP 契约
 * （terminal/create {sessionId, command, args?, cwd?}；
 * fs/write_text_file {sessionId, path, content}；
 * session/request_permission 的 result.outcome = selected/cancelled；
 * 阻断回 JSON-RPC error -32000）。
 * 引擎为真实 createEngine + 仓库内置 rules/ 与 policies/default.yaml。
 * e2e 用真实 spawn 的假 agent（node 子进程讲 NDJSON）+ PassThrough 客户端
 * 流 —— 判定层零 mock。
 */
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Engine } from "../../src/engine/index.js";
import { normalizeAcpRequest } from "../core/normalize.js";
import { createTestEngine } from "../core/testing.js";
import { AcpProxy, runProxy, type JsonRpcMessage } from "./proxy.js";

describe("acp 归一化（调研报告 src/acp.js:44-49 段）", () => {
  it("terminal/create → Bash（command 与 args join，cwd 进 input 与 context）", () => {
    const call = normalizeAcpRequest("terminal/create", {
      sessionId: "s1",
      command: "git",
      args: ["status", "--short"],
      cwd: "/repo",
    });
    expect(call.agent_id).toBe("acp");
    expect(call.session_id).toBe("s1");
    expect(call.tool).toEqual({ name: "Bash", action: "execute", category: "shell" });
    expect(call.input).toEqual({ command: "git status --short", cwd: "/repo" });
    expect(call.context).toEqual({ cwd: "/repo" });
  });

  it("fs/write_text_file → Write（path 映射 file_path）", () => {
    const call = normalizeAcpRequest("fs/write_text_file", {
      sessionId: "s1",
      path: "/repo/src/a.ts",
      content: "export {};\n",
    });
    expect(call.tool).toEqual({ name: "Write", action: "write", category: "filesystem" });
    expect(call.input).toEqual({ file_path: "/repo/src/a.ts", content: "export {};\n" });
  });

  it("参数非法（缺 command / args 非字符串数组）→ NormalizeError", () => {
    expect(() => normalizeAcpRequest("terminal/create", { sessionId: "s1" })).toThrow(/command/);
    expect(() =>
      normalizeAcpRequest("terminal/create", { command: "ls", args: [1] }),
    ).toThrow(/args/);
    expect(() =>
      normalizeAcpRequest("fs/write_text_file", { path: "/a", content: 42 }),
    ).toThrow(/content/);
  });

  it("非把守方法不送归一化", () => {
    expect(() => normalizeAcpRequest("fs/read_text_file", {})).toThrow(/不在把守范围/);
  });
});

describe("acp 代理判定（真实引擎 + 捕获 sink）", () => {
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

  function makeProxy() {
    const clientMsgs: JsonRpcMessage[] = [];
    const agentMsgs: JsonRpcMessage[] = [];
    const proxy = new AcpProxy(engine, {
      toClient: (m) => clientMsgs.push(m),
      toAgent: (m) => agentMsgs.push(m),
    });
    return { proxy, clientMsgs, agentMsgs };
  }

  function terminalCreate(id: number, command: string): JsonRpcMessage {
    return {
      jsonrpc: "2.0",
      id,
      method: "terminal/create",
      params: { sessionId: "s1", command, cwd: "/repo" },
    };
  }

  it("rm -rf / → 回 agent error -32000，不转发客户端", async () => {
    const { proxy, clientMsgs, agentMsgs } = makeProxy();
    await proxy.handleAgentMessage(terminalCreate(1, "rm -rf /"));
    expect(clientMsgs).toHaveLength(0);
    expect(agentMsgs).toHaveLength(1);
    expect(agentMsgs[0]).toMatchObject({ id: 1, error: { code: -32000 } });
    expect(agentMsgs[0]?.error?.message).toContain("AgentFence DENY");
    expect(agentMsgs[0]?.error?.message).toContain("fs.rm-recursive-guarded-path");
  });

  it("ls -la → 原样转发客户端；客户端响应路由回 agent", async () => {
    const { proxy, clientMsgs, agentMsgs } = makeProxy();
    const req = terminalCreate(2, "ls -la");
    await proxy.handleAgentMessage(req);
    expect(clientMsgs).toEqual([req]);
    expect(agentMsgs).toHaveLength(0);
    proxy.handleClientMessage({ jsonrpc: "2.0", id: 2, result: { terminalId: "t-1" } });
    expect(agentMsgs).toEqual([{ jsonrpc: "2.0", id: 2, result: { terminalId: "t-1" } }]);
  });

  it("fs/write_text_file 普通路径 → 放行转发", async () => {
    const { proxy, clientMsgs } = makeProxy();
    const req: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 3,
      method: "fs/write_text_file",
      params: { sessionId: "s1", path: "/repo/src/a.ts", content: "export {};" },
    };
    await proxy.handleAgentMessage(req);
    expect(clientMsgs).toEqual([req]);
  });

  it("git reset --hard → 注入 session/request_permission；客户端批准 → 转发原请求", async () => {
    const { proxy, clientMsgs, agentMsgs } = makeProxy();
    const req = terminalCreate(4, "git reset --hard HEAD~1");
    const pending = proxy.handleAgentMessage(req);
    await vi.waitFor(() => expect(clientMsgs).toHaveLength(1));
    const ask = clientMsgs[0];
    expect(ask?.method).toBe("session/request_permission");
    expect(ask?.id).toBe("agentfence:1");
    expect(ask?.params).toMatchObject({
      sessionId: "s1",
      toolCall: { kind: "execute", status: "pending" },
      options: [
        { optionId: "allow", kind: "allow_once" },
        { optionId: "reject", kind: "reject_once" },
      ],
    });
    proxy.handleClientMessage({
      jsonrpc: "2.0",
      id: "agentfence:1",
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    await pending;
    expect(clientMsgs[1]).toEqual(req);
    expect(agentMsgs).toHaveLength(0); // 无 error 回包
  });

  it("git reset --hard → 客户端拒绝 → error -32000（User rejected），原请求不转发", async () => {
    const { proxy, clientMsgs, agentMsgs } = makeProxy();
    const pending = proxy.handleAgentMessage(terminalCreate(5, "git reset --hard HEAD~1"));
    await vi.waitFor(() => expect(clientMsgs).toHaveLength(1));
    proxy.handleClientMessage({
      jsonrpc: "2.0",
      id: "agentfence:1",
      result: { outcome: { outcome: "selected", optionId: "reject" } },
    });
    await pending;
    expect(clientMsgs).toHaveLength(1); // terminal/create 未转发
    expect(agentMsgs[0]).toMatchObject({ id: 5, error: { code: -32000 } });
    expect(agentMsgs[0]?.error?.message).toContain("User rejected");
  });

  it("permission 请求被取消（outcome cancelled）→ 视同拒绝（fail-closed）", async () => {
    const { proxy, clientMsgs, agentMsgs } = makeProxy();
    const pending = proxy.handleAgentMessage(terminalCreate(6, "git reset --hard"));
    await vi.waitFor(() => expect(clientMsgs).toHaveLength(1));
    proxy.handleClientMessage({
      jsonrpc: "2.0",
      id: "agentfence:1",
      result: { outcome: { outcome: "cancelled" } },
    });
    await pending;
    expect(agentMsgs[0]).toMatchObject({ id: 6, error: { code: -32000 } });
  });

  it("归一化失败（缺 command）→ fail-closed error -32000", async () => {
    const { proxy, clientMsgs, agentMsgs } = makeProxy();
    await proxy.handleAgentMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "terminal/create",
      params: { sessionId: "s1" },
    });
    expect(clientMsgs).toHaveLength(0);
    expect(agentMsgs[0]).toMatchObject({ id: 7, error: { code: -32000 } });
    expect(agentMsgs[0]?.error?.message).toContain("fail-closed");
  });

  it("非把守方法（fs/read_text_file 请求、session/update 通知）直通", async () => {
    const { proxy, clientMsgs } = makeProxy();
    const readReq: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 8,
      method: "fs/read_text_file",
      params: { sessionId: "s1", path: "/etc/passwd" },
    };
    const notification: JsonRpcMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk" } },
    };
    await proxy.handleAgentMessage(readReq);
    await proxy.handleAgentMessage(notification);
    expect(clientMsgs).toEqual([readReq, notification]);
  });

  it("客户端请求（initialize）直通 agent；非对象消息丢弃并告警", async () => {
    const warnings: string[] = [];
    const clientMsgs: JsonRpcMessage[] = [];
    const agentMsgs: JsonRpcMessage[] = [];
    const proxy = new AcpProxy(engine, {
      toClient: (m) => clientMsgs.push(m),
      toAgent: (m) => agentMsgs.push(m),
      warn: (m) => warnings.push(m),
    });
    proxy.handleClientMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(agentMsgs[0]).toMatchObject({ id: 1, method: "initialize" });
    await proxy.handleAgentMessage("garbage");
    proxy.handleClientMessage(42);
    expect(clientMsgs).toHaveLength(0);
    expect(agentMsgs).toHaveLength(1);
    expect(warnings).toHaveLength(2);
  });
});

describe("acp 代理 e2e（真实子进程 NDJSON 全链路）", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const FAKE_AGENT = `
import { createInterface } from "node:readline";
process.stdout.write(JSON.stringify(JSON.parse(process.env.FAKE_AGENT_REQUEST)) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  const params = msg.error
    ? { kind: "error", message: msg.error.message }
    : { kind: "result", result: msg.result };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "test/result", params }) + "\\n");
  process.exit(0);
});
`;

  interface E2eRig {
    clientIn: PassThrough;
    clientOut: PassThrough;
    next: () => Promise<JsonRpcMessage>;
    send: (msg: JsonRpcMessage) => void;
    child: { kill: () => void };
  }

  function startRig(request: JsonRpcMessage): E2eRig {    const handle = createTestEngine();
    dirs.push(handle.dir);
    writeFileSync(path.join(handle.dir, "fake-agent.mjs"), FAKE_AGENT);
    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const queue: JsonRpcMessage[] = [];
    const waiters: ((m: JsonRpcMessage) => void)[] = [];
    createInterface({ input: clientOut }).on("line", (line) => {
      const msg = JSON.parse(line) as JsonRpcMessage;
      const w = waiters.shift();
      if (w !== undefined) w(msg);
      else queue.push(msg);
    });
    const child = runProxy(process.execPath, [path.join(handle.dir, "fake-agent.mjs")], {
      stdin: clientIn,
      stdout: clientOut,
      env: { ...process.env, FAKE_AGENT_REQUEST: JSON.stringify(request) },
      engine: handle.engine,
      onExit: () => undefined,
      warn: () => undefined,
    });
    return {
      clientIn,
      clientOut,
      child,
      send: (msg) => clientIn.write(JSON.stringify(msg) + "\n"),
      next: () => {
        const m = queue.shift();
        if (m !== undefined) return Promise.resolve(m);
        return new Promise((resolve) => waiters.push(resolve));
      },
    };
  }

  it("DENY：rm -rf / 被拦，agent 收到 -32000（客户端只见 agent 的汇报通知）", async () => {
    const rig = startRig({
      jsonrpc: "2.0",
      id: 1,
      method: "terminal/create",
      params: { sessionId: "s1", command: "rm -rf /" },
    });
    try {
      const msg = await rig.next();
      expect(msg.method).toBe("test/result");
      expect(msg.params).toMatchObject({ kind: "error" });
      expect((msg.params as { message: string }).message).toContain(
        "fs.rm-recursive-guarded-path",
      );
    } finally {
      rig.child.kill();
    }
  });

  it("REVIEW 批准链路：permission 请求 → 客户端批准 → 转发 → 响应路由回 agent", async () => {
    const rig = startRig({
      jsonrpc: "2.0",
      id: 7,
      method: "terminal/create",
      params: { sessionId: "s1", command: "git", args: ["reset", "--hard", "HEAD~1"] },
    });
    try {
      const ask = await rig.next();
      expect(ask.method).toBe("session/request_permission");
      rig.send({
        jsonrpc: "2.0",
        id: ask.id ?? "",
        result: { outcome: { outcome: "selected", optionId: "allow" } },
      });
      const forwarded = await rig.next();
      expect(forwarded).toMatchObject({ id: 7, method: "terminal/create" });
      rig.send({ jsonrpc: "2.0", id: 7, result: { terminalId: "t-1" } });
      const done = await rig.next();
      expect(done.params).toMatchObject({ kind: "result", result: { terminalId: "t-1" } });
    } finally {
      rig.child.kill();
    }
  });
});
