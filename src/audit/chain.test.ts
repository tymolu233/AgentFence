import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Decision, ToolCall } from "../api/types.js";
import { buildAuditRecord } from "./record.js";
import { GENESIS_HASH } from "./types.js";
import type { AuditRecord } from "./types.js";
import { AuditLogWriter, verifyChain } from "./writer.js";

const call: ToolCall = {
  request_id: "req_1",
  agent_id: "opencode",
  tool: { name: "shell", action: "execute" },
  input: { command: "rm -rf /" },
};

const decision: Decision = {
  decision: "DENY",
  risk: "CRITICAL",
  confidence: 1,
  matched_rules: ["fs.rm-recursive-guarded-path"],
  decision_layer: "rules",
  reason: "recursive delete on guarded path",
  policy_version: "2026-09-23.1",
};

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "agentfence-audit-")), "audit.jsonl");
}

function readRecords(file: string): AuditRecord[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
}

describe("audit hash chain", () => {
  it("chains records from genesis and verifies", () => {
    const file = tempFile();
    const writer = new AuditLogWriter(file);
    const first = writer.append(
      buildAuditRecord(call, decision, {
        judge_used: false,
        timestamp: "2026-09-23T00:00:00.000Z",
      }),
    );
    const second = writer.append(
      buildAuditRecord(
        { ...call, request_id: "req_2" },
        { ...decision, decision: "ALLOW", risk: "LOW" },
        { judge_used: false, timestamp: "2026-09-23T00:00:01.000Z" },
      ),
    );
    expect(first.prev_hash).toBe(GENESIS_HASH);
    expect(second.prev_hash).toBe(first.hash);
    expect(second.hash).not.toBe(first.hash);
    expect(verifyChain(file)).toEqual({ ok: true });
  });

  it("stores only input_digest, never raw input", () => {
    const file = tempFile();
    const writer = new AuditLogWriter(file);
    writer.append(buildAuditRecord(call, decision, { judge_used: false }));
    const [stored] = readRecords(file);
    expect(stored).toBeDefined();
    expect(stored?.input_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("rm -rf");
    expect(raw).not.toContain('"input"');
  });

  it("detects tampered line content", () => {
    const file = tempFile();
    const writer = new AuditLogWriter(file);
    for (let i = 0; i < 3; i++) {
      writer.append(
        buildAuditRecord({ ...call, request_id: `req_${i}` }, decision, {
          judge_used: false,
        }),
      );
    }
    const records = readRecords(file);
    const tampered = records[1];
    expect(tampered).toBeDefined();
    if (tampered === undefined) return;
    tampered.decision = "ALLOW";
    records[1] = tampered;
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    expect(verifyChain(file)).toEqual({ ok: false, line: 2 });
  });

  it("detects a deleted line", () => {
    const file = tempFile();
    const writer = new AuditLogWriter(file);
    for (let i = 0; i < 3; i++) {
      writer.append(
        buildAuditRecord({ ...call, request_id: `req_${i}` }, decision, {
          judge_used: false,
        }),
      );
    }
    const records = readRecords(file);
    records.splice(1, 1);
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    expect(verifyChain(file)).toEqual({ ok: false, line: 2 });
  });

  it("detects a corrupted line", () => {
    const file = tempFile();
    const writer = new AuditLogWriter(file);
    writer.append(buildAuditRecord(call, decision, { judge_used: false }));
    writeFileSync(file, readFileSync(file, "utf8") + "not-json\n", "utf8");
    expect(verifyChain(file)).toEqual({ ok: false, line: 2 });
  });

  it("resumes the chain from an existing file tail", () => {
    const file = tempFile();
    const first = new AuditLogWriter(file).append(
      buildAuditRecord(call, decision, { judge_used: false }),
    );
    const reopened = new AuditLogWriter(file);
    expect(reopened.lastHash).toBe(first.hash);
    const second = reopened.append(
      buildAuditRecord({ ...call, request_id: "req_2" }, decision, { judge_used: true }),
    );
    expect(second.prev_hash).toBe(first.hash);
    expect(verifyChain(file)).toEqual({ ok: true });
  });

  it("verifies an empty file as ok", () => {
    const file = tempFile();
    writeFileSync(file, "", "utf8");
    expect(verifyChain(file)).toEqual({ ok: true });
  });
});
