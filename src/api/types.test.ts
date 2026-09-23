import { describe, expect, it } from "vitest";
import type { CheckRequest, Decision, ToolCall } from "./types.js";

const toolCall: ToolCall = {
  request_id: "req_1",
  agent_id: "opencode",
  session_id: "s_1",
  run_id: "r_1",
  tool: { name: "shell", action: "execute", category: "shell" },
  input: { command: "rm -rf /" },
  input_digest: "sha256:abc",
  context: { environment: "sandbox", trust_level: 3 },
  session: {
    user_intent: "SQL injection testing",
    recent_tool_calls: ["http GET https://lab.example"],
    flagged_untrusted: [{ kind: "injection", excerpt: "ignore previous", p: 0.82 }],
  },
};

describe("api contract v1", () => {
  it("ToolCall survives JSON round-trip", () => {
    const restored = JSON.parse(JSON.stringify(toolCall)) as ToolCall;
    expect(restored).toEqual(toolCall);
  });

  it("Decision carries required fields", () => {
    const decision: Decision = {
      decision: "DENY",
      risk: "CRITICAL",
      confidence: 1,
      matched_rules: ["fs.rm-recursive-guarded-path"],
      decision_layer: "rules",
      reason: "recursive delete on guarded path",
      latency_ms: 1.2,
      policy_version: "2026-09-23.1",
    };
    const restored = JSON.parse(JSON.stringify(decision)) as Decision;
    expect(restored).toEqual(decision);
  });

  it("CheckRequest minimal shape needs only agent/tool/action/input", () => {
    const req: CheckRequest = {
      agent: "opencode",
      tool: "shell",
      action: "execute",
      input: { command: "ls" },
    };
    expect(req.tool).toBe("shell");
  });
});
