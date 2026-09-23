import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ToolCall } from "../api/types.js";
import { createPolicyEngine } from "./engine.js";
import { StructuredEvaluator } from "./evaluator.js";
import { loadPolicyFile, parsePolicyConfig } from "./loader.js";
import type { PolicyConfig, PolicyRule, RulesOutcome } from "./types.js";

const DEFAULT_POLICY_PATH = fileURLToPath(
  new URL("../../policies/default.yaml", import.meta.url),
);

function makeCall(overrides: {
  agent?: string;
  tool?: string;
  action?: string;
  environment?: string;
  target?: string;
}): ToolCall {
  return {
    request_id: "req_test",
    agent_id: overrides.agent ?? "pentest-agent",
    tool: { name: overrides.tool ?? "shell", action: overrides.action ?? "read" },
    input: {},
    ...(overrides.environment !== undefined || overrides.target !== undefined
      ? {
          context: {
            ...(overrides.environment !== undefined
              ? { environment: overrides.environment }
              : {}),
            ...(overrides.target !== undefined ? { target: overrides.target } : {}),
          },
        }
      : {}),
  };
}

const defaultConfig = loadPolicyFile(DEFAULT_POLICY_PATH);

describe("environment policy matrix (default.yaml)", () => {
  it("destructive in sandbox → REVIEW", () => {
    const engine = createPolicyEngine(defaultConfig);
    const verdict = engine.decide({
      call: makeCall({ action: "delete", environment: "sandbox" }),
    });
    expect(verdict).toMatchObject({ verdict: "REVIEW" });
    expect(verdict?.policy_id).toBe("policy.sandbox.destructive");
  });

  it("same destructive action in production → DENY", () => {
    const engine = createPolicyEngine(defaultConfig);
    const verdict = engine.decide({
      call: makeCall({ action: "delete", environment: "production" }),
    });
    expect(verdict).toMatchObject({ verdict: "DENY" });
    expect(verdict?.policy_id).toBe("policy.production.destructive");
  });

  it("credential_access in production → DENY", () => {
    const engine = createPolicyEngine(defaultConfig);
    const verdict = engine.decide({
      call: makeCall({ action: "credential_access", environment: "production" }),
    });
    expect(verdict?.verdict).toBe("DENY");
  });

  it("read-only action → ALLOW via structured rule in any environment", () => {
    const engine = createPolicyEngine(defaultConfig);
    for (const environment of ["sandbox", "production"]) {
      const verdict = engine.decide({
        call: makeCall({ action: "query", environment }),
      });
      expect(verdict).toMatchObject({
        verdict: "ALLOW",
        policy_id: "policy.read.recon",
      });
    }
  });
});

describe("shadow mode", () => {
  const shadowConfig: PolicyConfig = { ...defaultConfig, enforcement: "shadow" };

  it("production destructive → ALLOW with would_block, no DENY emitted", () => {
    const engine = createPolicyEngine(shadowConfig);
    const verdict = engine.decide({
      call: makeCall({ action: "delete", environment: "production" }),
    });
    expect(verdict).toMatchObject({
      verdict: "ALLOW",
      would_block: true,
      policy_id: "policy.production.destructive",
    });
  });

  it("sandbox destructive REVIEW is also downgraded to marked ALLOW", () => {
    const engine = createPolicyEngine(shadowConfig);
    const verdict = engine.decide({
      call: makeCall({ action: "delete", environment: "sandbox" }),
    });
    expect(verdict).toMatchObject({ verdict: "ALLOW", would_block: true });
  });

  it("genuine ALLOW stays unmarked", () => {
    const engine = createPolicyEngine(shadowConfig);
    const verdict = engine.decide({
      call: makeCall({ action: "read", environment: "production" }),
    });
    expect(verdict).toMatchObject({ verdict: "ALLOW" });
    expect(verdict?.would_block).toBeUndefined();
  });
});

describe("fail-closed on missing policy", () => {
  it("no policy opinion + high risk → DENY", () => {
    const engine = createPolicyEngine(defaultConfig);
    const rules: RulesOutcome = { risk: "HIGH", matched_rules: [] };
    const verdict = engine.decide({
      call: makeCall({ action: "write", environment: "staging" }),
      rules,
    });
    expect(verdict).toMatchObject({
      verdict: "DENY",
      policy_id: "policy.fail_closed",
    });
  });

  it("no policy opinion + low risk → null (defer to later layers)", () => {
    const engine = createPolicyEngine(defaultConfig);
    const verdict = engine.decide({
      call: makeCall({ action: "write", environment: "staging" }),
      rules: { risk: "LOW" },
    });
    expect(verdict).toBeNull();
  });

  it("unknown environment + critical risk → DENY", () => {
    const engine = createPolicyEngine(defaultConfig);
    const verdict = engine.decide({
      call: makeCall({ action: "write", environment: "lab" }),
      rules: { risk: "CRITICAL" },
    });
    expect(verdict?.verdict).toBe("DENY");
  });
});

describe("default / missing field behavior", () => {
  it("no context at all + no rules outcome + unmatched action → null", () => {
    const engine = createPolicyEngine(defaultConfig);
    const verdict = engine.decide({ call: makeCall({ action: "write" }) });
    expect(verdict).toBeNull();
  });

  it("missing environment → environment policy skipped, rules still apply", () => {
    const engine = createPolicyEngine(defaultConfig);
    const verdict = engine.decide({ call: makeCall({ action: "read" }) });
    expect(verdict).toMatchObject({ verdict: "ALLOW", policy_id: "policy.read.recon" });
  });

  it("condition on risk does not match when rules risk is absent (fail-safe)", () => {
    const evaluator = new StructuredEvaluator();
    const rules: PolicyRule[] = [
      {
        id: "r.risk",
        priority: 1,
        verdict: "DENY",
        conditions: [{ field: "risk", operator: "eq", value: "HIGH" }],
      },
    ];
    const verdict = evaluator.evaluate({ call: makeCall({ action: "read" }) }, rules);
    expect(verdict).toBeNull();
  });

  it("unknown action class → environment policy has no opinion", () => {
    const engine = createPolicyEngine(defaultConfig);
    const verdict = engine.decide({
      call: makeCall({ action: "teleport", environment: "production" }),
      rules: { risk: "LOW" },
    });
    expect(verdict).toBeNull();
  });
});

describe("structured evaluator", () => {
  const evaluator = new StructuredEvaluator();

  it("first match by priority wins (lower number first, regardless of order)", () => {
    const rules: PolicyRule[] = [
      {
        id: "r.late",
        priority: 50,
        verdict: "REVIEW",
        conditions: [{ field: "tool", operator: "eq", value: "shell" }],
      },
      {
        id: "r.early",
        priority: 10,
        verdict: "DENY",
        conditions: [{ field: "tool", operator: "eq", value: "shell" }],
      },
    ];
    const verdict = evaluator.evaluate({ call: makeCall({}) }, rules);
    expect(verdict).toMatchObject({ verdict: "DENY", policy_id: "r.early" });
  });

  it("all conditions must match (AND)", () => {
    const rules: PolicyRule[] = [
      {
        id: "r.and",
        priority: 1,
        verdict: "DENY",
        conditions: [
          { field: "agent", operator: "eq", value: "pentest-agent" },
          { field: "environment", operator: "eq", value: "production" },
        ],
      },
    ];
    const miss = evaluator.evaluate(
      { call: makeCall({ environment: "sandbox" }) },
      rules,
    );
    expect(miss).toBeNull();
    const hit = evaluator.evaluate(
      { call: makeCall({ environment: "production" }) },
      rules,
    );
    expect(hit?.verdict).toBe("DENY");
  });

  it("operators ne / in / not_in", () => {
    const rules: PolicyRule[] = [
      {
        id: "r.ne",
        priority: 1,
        verdict: "REVIEW",
        conditions: [{ field: "environment", operator: "ne", value: "sandbox" }],
      },
      {
        id: "r.not_in",
        priority: 2,
        verdict: "DENY",
        conditions: [
          { field: "agent", operator: "not_in", value: ["trusted-ci"] },
        ],
      },
    ];
    // sandbox 命中 r.ne 的反向（ne 不命中），落到 r.not_in
    const sandbox = evaluator.evaluate(
      { call: makeCall({ environment: "sandbox" }) },
      rules,
    );
    expect(sandbox).toMatchObject({ verdict: "DENY", policy_id: "r.not_in" });
    // production 命中 r.ne（priority 更小）
    const prod = evaluator.evaluate(
      { call: makeCall({ environment: "production" }) },
      rules,
    );
    expect(prod).toMatchObject({ verdict: "REVIEW", policy_id: "r.ne" });
    // trusted-ci 在 not_in 名单里 → 不命中
    const trusted = evaluator.evaluate(
      { call: makeCall({ agent: "trusted-ci", environment: "sandbox" }) },
      rules,
    );
    expect(trusted).toBeNull();
  });
});

describe("cheapest-deny-first short-circuits", () => {
  it("rules-layer DENY passes through and cannot be softened by policy ALLOW", () => {
    const engine = createPolicyEngine(defaultConfig);
    const verdict = engine.decide({
      call: makeCall({ action: "read", environment: "sandbox" }),
      rules: { verdict: "DENY", risk: "CRITICAL", matched_rules: ["fs.rm-recursive"] },
    });
    expect(verdict).toMatchObject({ verdict: "DENY", policy_id: "rules.passthrough" });
    expect(verdict?.reason).toContain("fs.rm-recursive");
  });

  it("allow-list: tool not listed → DENY before any policy evaluation", () => {
    const config = parsePolicyConfig(`
version: 1
mode: fail_closed
allowed_tools: [http, scanner]
policy: {}
`);
    const engine = createPolicyEngine(config);
    const denied = engine.decide({ call: makeCall({ tool: "shell" }) });
    expect(denied).toMatchObject({ verdict: "DENY", policy_id: "policy.allow_list" });
    const allowed = engine.decide({ call: makeCall({ tool: "http" }) });
    expect(allowed).toBeNull();
  });
});

describe("autonomy budget", () => {
  it("ALLOW downgraded to REVIEW when rules risk >= HIGH", () => {
    const engine = createPolicyEngine(defaultConfig);
    const verdict = engine.decide({
      call: makeCall({ action: "read", environment: "sandbox" }),
      rules: { risk: "HIGH" },
    });
    expect(verdict).toMatchObject({
      verdict: "REVIEW",
      policy_id: "policy.read.recon",
    });
    expect(verdict?.reason).toContain("autonomy budget");
  });

  it("ALLOW kept when risk below budget threshold", () => {
    const engine = createPolicyEngine(defaultConfig);
    const verdict = engine.decide({
      call: makeCall({ action: "read", environment: "sandbox" }),
      rules: { risk: "MEDIUM" },
    });
    expect(verdict?.verdict).toBe("ALLOW");
  });

  it("budget never upgrades: DENY stays DENY regardless of risk", () => {
    const engine = createPolicyEngine(defaultConfig);
    const verdict = engine.decide({
      call: makeCall({ action: "delete", environment: "production" }),
      rules: { risk: "LOW" },
    });
    expect(verdict?.verdict).toBe("DENY");
  });
});
