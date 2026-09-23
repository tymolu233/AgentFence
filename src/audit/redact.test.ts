import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Decision, ToolCall } from "../api/types.js";
import { buildAuditRecord } from "./record.js";
import { redactSecrets } from "./redact.js";
import { AuditLogWriter, verifyChain } from "./writer.js";

describe("secret redaction", () => {
  it("redacts ghp_ tokens", () => {
    const token = `ghp_${"a".repeat(36)}`;
    expect(redactSecrets(`token: ${token}`)).toBe("token: [REDACTED:github_token]");
  });

  it("redacts github_pat_ tokens", () => {
    const token = `github_pat_${"A".repeat(22)}_${"b".repeat(59)}`;
    expect(redactSecrets(`pat=${token}`)).toBe("pat=[REDACTED:github_pat]");
  });

  it("redacts AWS AKIA access key ids", () => {
    const key = `AKIA${"0ABCDEF1".repeat(2)}`;
    expect(redactSecrets(`aws ${key} end`)).toBe("aws [REDACTED:aws_access_key] end");
  });

  it("redacts private key blocks including the body", () => {
    const pem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";
    const out = redactSecrets(`key follows\n${pem}\ndone`);
    expect(out).toBe("key follows\n[REDACTED:private_key]\ndone");
    expect(out).not.toContain("b3BlbnNzaC1rZXktdjEAAAAA");
  });

  it("leaves ordinary text untouched", () => {
    const text = "recursive delete on guarded path /etc";
    expect(redactSecrets(text)).toBe(text);
  });

  it("redacts reason before persisting, including ALLOW records", () => {
    const file = join(mkdtempSync(join(tmpdir(), "agentfence-redact-")), "audit.jsonl");
    const writer = new AuditLogWriter(file);
    const token = `ghp_${"c".repeat(36)}`;
    const call: ToolCall = {
      request_id: "req_allow",
      agent_id: "opencode",
      tool: { name: "http", action: "get" },
      input: { url: "https://example.com" },
    };
    const decision: Decision = {
      decision: "ALLOW",
      risk: "LOW",
      confidence: 0.9,
      matched_rules: [],
      decision_layer: "acl",
      reason: `caller presented ${token}`,
    };
    writer.append(buildAuditRecord(call, decision, { judge_used: false }));
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain('"decision":"ALLOW"');
    expect(raw).toContain("[REDACTED:github_token]");
    expect(raw).not.toContain(token);
    expect(verifyChain(file)).toEqual({ ok: true });
  });
});
