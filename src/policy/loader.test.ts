import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PolicyLoadError, loadPolicyFile, parsePolicyConfig } from "./loader.js";

const DEFAULT_POLICY_PATH = fileURLToPath(
  new URL("../../policies/default.yaml", import.meta.url),
);

describe("loadPolicyFile", () => {
  it("loads policies/default.yaml", () => {
    const config = loadPolicyFile(DEFAULT_POLICY_PATH);
    expect(config.version).toBe(1);
    expect(config.mode).toBe("fail_closed");
    expect(config.enforcement).toBe("enforce");
    expect(config.policy.production).toEqual({
      destructive: "DENY",
      credential_access: "DENY",
    });
    expect(config.policy.sandbox).toEqual({ destructive: "REVIEW" });
    expect(config.autonomy_budget).toEqual({ downgrade_allow_at: "HIGH" });
    expect(config.rules.length).toBeGreaterThan(0);
    expect(config.rules.map((r) => r.id)).toContain("policy.read.recon");
  });
});

describe("parsePolicyConfig validation (fail-closed)", () => {
  it("rejects invalid YAML", () => {
    expect(() => parsePolicyConfig("version: [unclosed")).toThrow(PolicyLoadError);
  });

  it("rejects non-mapping root", () => {
    expect(() => parsePolicyConfig("- just\n- a\n- list\n")).toThrow(PolicyLoadError);
  });

  it("rejects wrong version", () => {
    expect(() =>
      parsePolicyConfig("version: 2\nmode: fail_closed\n"),
    ).toThrow(/version/);
  });

  it("rejects mode other than fail_closed", () => {
    expect(() =>
      parsePolicyConfig("version: 1\nmode: fail_open\n"),
    ).toThrow(/mode/);
  });

  it("rejects unknown environment key", () => {
    expect(() =>
      parsePolicyConfig(`
version: 1
mode: fail_closed
policy:
  moonbase:
    destructive: deny
`),
    ).toThrow(/policy\.moonbase/);
  });

  it("rejects unknown action class", () => {
    expect(() =>
      parsePolicyConfig(`
version: 1
mode: fail_closed
policy:
  production:
    teleport: deny
`),
    ).toThrow(/teleport/);
  });

  it("rejects unknown verdict in environment policy", () => {
    expect(() =>
      parsePolicyConfig(`
version: 1
mode: fail_closed
policy:
  production:
    destructive: maybe
`),
    ).toThrow(/destructive/);
  });

  it("rejects unknown condition field", () => {
    expect(() =>
      parsePolicyConfig(`
version: 1
mode: fail_closed
rules:
  - id: r1
    priority: 1
    verdict: deny
    conditions:
      - { field: horoscope, operator: eq, value: leo }
`),
    ).toThrow(/field/);
  });

  it("rejects unknown condition operator", () => {
    expect(() =>
      parsePolicyConfig(`
version: 1
mode: fail_closed
rules:
  - id: r1
    priority: 1
    verdict: deny
    conditions:
      - { field: tool, operator: regex, value: "rm.*" }
`),
    ).toThrow(/operator/);
  });

  it("rejects scalar value for in operator", () => {
    expect(() =>
      parsePolicyConfig(`
version: 1
mode: fail_closed
rules:
  - id: r1
    priority: 1
    verdict: deny
    conditions:
      - { field: tool, operator: in, value: shell }
`),
    ).toThrow(/value/);
  });

  it("rejects rule without id / priority", () => {
    expect(() =>
      parsePolicyConfig(`
version: 1
mode: fail_closed
rules:
  - priority: 1
    verdict: deny
    conditions: []
`),
    ).toThrow(/id/);
    expect(() =>
      parsePolicyConfig(`
version: 1
mode: fail_closed
rules:
  - id: r1
    verdict: deny
    conditions: []
`),
    ).toThrow(/priority/);
  });

  it("rejects bad autonomy_budget threshold", () => {
    expect(() =>
      parsePolicyConfig(`
version: 1
mode: fail_closed
autonomy_budget:
  downgrade_allow_at: MEDIUM
`),
    ).toThrow(/autonomy_budget/);
  });

  it("rejects bad enforcement mode", () => {
    expect(() =>
      parsePolicyConfig("version: 1\nmode: fail_closed\nenforcement: yolo\n"),
    ).toThrow(/enforcement/);
  });

  it("normalizes lowercase verdicts to DecisionKind", () => {
    const config = parsePolicyConfig(`
version: 1
mode: fail_closed
policy:
  sandbox:
    destructive: review
rules:
  - id: r1
    priority: 1
    verdict: deny
    conditions: []
`);
    expect(config.policy.sandbox?.destructive).toBe("REVIEW");
    expect(config.rules[0]?.verdict).toBe("DENY");
  });

  it("defaults enforcement to enforce and tolerates absent optional sections", () => {
    const config = parsePolicyConfig("version: 1\nmode: fail_closed\n");
    expect(config.enforcement).toBe("enforce");
    expect(config.rules).toEqual([]);
    expect(config.policy).toEqual({});
    expect(config.autonomy_budget).toBeUndefined();
  });
});
