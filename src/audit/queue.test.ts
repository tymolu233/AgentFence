import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Decision, ToolCall } from "../api/types.js";
import { applyAuditBackpressure, AuditQueue } from "./queue.js";
import { buildAuditRecord } from "./record.js";
import { AuditLogWriter, verifyChain } from "./writer.js";

const call: ToolCall = {
  request_id: "req_1",
  agent_id: "opencode",
  tool: { name: "shell", action: "execute" },
  input: { command: "ls" },
};

const allowDecision: Decision = {
  decision: "ALLOW",
  risk: "LOW",
  confidence: 0.99,
  matched_rules: [],
  decision_layer: "acl",
  reason: "allowed by acl",
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agentfence-queue-"));
}

function lineCount(file: string): number {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
}

function makeQueue(dir: string, mode: "best_effort" | "durable" | "fail_closed") {
  const file = join(dir, "audit.jsonl");
  const queue = new AuditQueue({
    writer: new AuditLogWriter(file),
    mode,
    capacity: 1,
    spillPath: join(dir, "spill.jsonl"),
  });
  return { file, queue };
}

describe("audit queue backpressure", () => {
  it("drains asynchronously: record() returns before anything hits disk", async () => {
    const dir = tempDir();
    const { file, queue } = makeQueue(dir, "best_effort");
    const result = queue.record(
      buildAuditRecord(call, allowDecision, { judge_used: false }),
    );
    expect(result).toEqual({ queued: true });
    expect(existsSync(file)).toBe(false);
    await queue.flush();
    expect(lineCount(file)).toBe(1);
    await queue.close();
  });

  it("best_effort drops when full and counts dropped", async () => {
    const dir = tempDir();
    const { file, queue } = makeQueue(dir, "best_effort");
    for (let i = 0; i < 3; i++) {
      const result = queue.record(
        buildAuditRecord({ ...call, request_id: `req_${i}` }, allowDecision, {
          judge_used: false,
        }),
      );
      expect(result).toEqual({ queued: true });
    }
    await queue.close();
    const stats = queue.stats();
    expect(stats.received).toBe(3);
    expect(stats.dropped).toBe(2);
    expect(stats.written).toBe(1);
    expect(lineCount(file)).toBe(1);
    expect(verifyChain(file)).toEqual({ ok: true });
  });

  it("durable spills overflow to disk and replays on drain", async () => {
    const dir = tempDir();
    const { file, queue } = makeQueue(dir, "durable");
    for (let i = 0; i < 3; i++) {
      queue.record(
        buildAuditRecord({ ...call, request_id: `req_${i}` }, allowDecision, {
          judge_used: false,
        }),
      );
    }
    expect(existsSync(join(dir, "spill.jsonl"))).toBe(true);
    await queue.close();
    const stats = queue.stats();
    expect(stats.spilled).toBe(2);
    expect(stats.replayed).toBe(2);
    expect(stats.dropped).toBe(0);
    expect(stats.written).toBe(3);
    expect(lineCount(file)).toBe(3);
    expect(existsSync(join(dir, "spill.jsonl"))).toBe(false);
    expect(verifyChain(file)).toEqual({ ok: true });
  });

  it("durable replays a spill file left behind by a previous run", async () => {
    const dir = tempDir();
    const file = join(dir, "audit.jsonl");
    const spillPath = join(dir, "spill.jsonl");
    // 上一轮：落盘 1 条后崩溃，spill 文件遗留 2 条
    new AuditLogWriter(file).append(
      buildAuditRecord(call, allowDecision, { judge_used: false }),
    );
    const spilled = [1, 2].map((i) =>
      JSON.stringify(
        buildAuditRecord({ ...call, request_id: `req_${i}` }, allowDecision, {
          judge_used: false,
        }),
      ),
    );
    writeFileSync(spillPath, spilled.join("\n") + "\n", "utf8");
    // 新一轮启动：spill 在首次 drain 时被重放，链从已有末行续写
    const queue = new AuditQueue({
      writer: new AuditLogWriter(file),
      mode: "durable",
      capacity: 10,
      spillPath,
    });
    queue.record(
      buildAuditRecord({ ...call, request_id: "req_3" }, allowDecision, {
        judge_used: false,
      }),
    );
    await queue.close();
    expect(queue.stats().replayed).toBe(2);
    expect(lineCount(file)).toBe(4);
    expect(existsSync(spillPath)).toBe(false);
    expect(verifyChain(file)).toEqual({ ok: true });
  });

  it("fail_closed returns an error signal when full and never throws", async () => {
    const dir = tempDir();
    const { file, queue } = makeQueue(dir, "fail_closed");
    const first = queue.record(
      buildAuditRecord(call, allowDecision, { judge_used: false }),
    );
    expect(first).toEqual({ queued: true });
    const full = queue.record(
      buildAuditRecord({ ...call, request_id: "req_2" }, allowDecision, {
        judge_used: false,
      }),
    );
    expect(full).toEqual({ queued: false, code: "QUEUE_FULL" });
    await queue.close();
    expect(queue.record(buildAuditRecord(call, allowDecision, { judge_used: false }))).toEqual(
      { queued: false, code: "CLOSED" },
    );
    expect(queue.stats().written).toBe(1);
    expect(lineCount(file)).toBe(1);
  });

  it("applyAuditBackpressure rewrites non-DENY to DENY on the error signal", () => {
    const full = { queued: false, code: "QUEUE_FULL" } as const;
    const rewritten = applyAuditBackpressure(allowDecision, full);
    expect(rewritten.decision).toBe("DENY");
    expect(rewritten.reason).toContain("fail-closed");
    const deny: Decision = { ...allowDecision, decision: "DENY", risk: "HIGH" };
    expect(applyAuditBackpressure(deny, full)).toBe(deny);
    expect(applyAuditBackpressure(allowDecision, { queued: true })).toBe(allowDecision);
  });
});
