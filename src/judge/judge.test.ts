import { describe, expect, it } from "vitest";
import type { ToolCall } from "../api/types.js";
import { decide } from "./decide.js";
import { NoopJudge } from "./noop.js";
import type { JudgeAnswers } from "./types.js";

const base: JudgeAnswers = {
  risk: 0,
  approval: 0,
  user_requested: 0,
  from_untrusted: 0,
};

const call: ToolCall = {
  request_id: "req_1",
  agent_id: "opencode",
  tool: { name: "shell", action: "execute" },
  input: { command: "ls" },
};

describe("decide 顺序敏感用例（永不可删）", () => {
  it("from_untrusted 0.9 + user_requested 1.0 → 仍 DENY（注入一票否决最优先）", () => {
    expect(
      decide({ ...base, from_untrusted: 0.9, user_requested: 1.0 }),
    ).toBe("DENY");
  });

  it("risk 3 + user_requested 1.0 → 仍 DENY（user_requested 永不解 DENY）", () => {
    expect(decide({ ...base, risk: 3, user_requested: 1.0 })).toBe("DENY");
  });

  it("risk 2.0 + user_requested 0.9 → ALLOW（灰区被用户亲口要求降级）", () => {
    expect(decide({ ...base, risk: 2.0, user_requested: 0.9 })).toBe("ALLOW");
  });

  it("risk 2.0 + user_requested 0.1 → REVIEW（灰区无降级）", () => {
    expect(decide({ ...base, risk: 2.0, user_requested: 0.1 })).toBe("REVIEW");
  });

  it("risk 0.5 → ALLOW（低于灰区下界）", () => {
    expect(decide({ ...base, risk: 0.5 })).toBe("ALLOW");
  });

  it("自定义阈值覆盖生效", () => {
    const answers: JudgeAnswers = { ...base, risk: 2.0, user_requested: 0.1 };
    expect(decide(answers, { risk_deny: 2.0 })).toBe("DENY");
    expect(decide(answers, { risk_review: 2.1 })).toBe("ALLOW");
    expect(decide(answers, { user_requested_allow: 0.1 })).toBe("ALLOW");
    expect(
      decide({ ...base, from_untrusted: 0.5 }, { from_untrusted: 0.5 }),
    ).toBe("DENY");
  });
});

describe("decide 阈值边界与灰区语义", () => {
  it("from_untrusted 恰为 0.70 → DENY；0.69 → 不触发一票否决", () => {
    expect(decide({ ...base, from_untrusted: 0.7 })).toBe("DENY");
    expect(decide({ ...base, from_untrusted: 0.69 })).toBe("ALLOW");
  });

  it("risk 恰为 2.5 → DENY；2.49 → 落入灰区 REVIEW", () => {
    expect(decide({ ...base, risk: 2.5 })).toBe("DENY");
    expect(decide({ ...base, risk: 2.49 })).toBe("REVIEW");
  });

  it("approval ≥ 0.75 单独构成灰区，user_requested ≥ 0.85 可降级", () => {
    expect(decide({ ...base, approval: 0.75 })).toBe("REVIEW");
    expect(
      decide({ ...base, approval: 0.8, user_requested: 0.85 }),
    ).toBe("ALLOW");
  });

  it("user_requested 再高也不影响非灰区调用", () => {
    expect(decide({ ...base, risk: 1.0, user_requested: 1.0 })).toBe("ALLOW");
  });
});

describe("NoopJudge", () => {
  it("assess 抛 judge disabled（上层保证不调用它）", async () => {
    const judge = new NoopJudge();
    await expect(judge.assess(call)).rejects.toThrow("judge disabled");
  });
});
