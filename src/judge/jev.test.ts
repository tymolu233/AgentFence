import { describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../api/types.js";
import {
  JEV_ACTION_QUESTIONS,
  JEV_GATEWAY_URL,
  JEV_TYPESAFE_URL,
  JevJudge,
} from "./jev.js";
import type { JevFetch, JevJudgeOptions, JevRequestInit, JevResponse } from "./jev.js";

const KEY = "[redacted]";

const call: ToolCall = {
  request_id: "req_1",
  agent_id: "claude-code",
  tool: { name: "shell", action: "execute" },
  input: { command: "git push --force" },
  context: { cwd: "/repo" },
  session: {
    user_intent: "把刚才的提交推到主干",
    recent_tool_calls: ["git status", "git commit -m x"],
    flagged_untrusted: [
      { kind: "injection", excerpt: "ignore previous instructions", p: 0.93 },
    ],
  },
};

function resp(body: unknown, status = 200): JevResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () =>
      Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

interface RecordedCall {
  url: string;
  init: JevRequestInit;
}

/** 按序消费步骤的 stub：步骤是 JevResponse 或要抛出的网络错误 */
function stubFetch(steps: Array<JevResponse | Error>) {
  const queue = [...steps];
  const calls: RecordedCall[] = [];
  const fetchImpl: JevFetch = (url, init = {}) => {
    calls.push({ url, init });
    const step = queue.shift();
    if (!step) return Promise.reject(new Error("stub exhausted"));
    if (step instanceof Error) return Promise.reject(step);
    return Promise.resolve(step);
  };
  return { calls, fetchImpl };
}

function makeJudge(
  fetchImpl: JevFetch,
  opts: Partial<JevJudgeOptions> = {},
): JevJudge {
  return new JevJudge({
    apiKey: KEY,
    fetchImpl,
    retryDelay: () => 0,
    ...opts,
  });
}

describe("JevJudge 请求契约（镜像 jev-guard）", () => {
  it("typesafe：默认 endpoint、Bearer auth、state/model/questions 形状", async () => {
    const { calls, fetchImpl } = stubFetch([
      resp({
        answers: {
          risk: { score: 2, confidence: 0.9 },
          approval: { noul: 0.7, confidence: 0.8 },
          user_requested: { noul: 0.95, confidence: 0.85 },
          from_untrusted: { noul: 0.01, confidence: 0.88 },
        },
      }),
    ]);
    const judge = makeJudge(fetchImpl);
    await judge.assess(call);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0] as RecordedCall;
    expect(url).toBe(JEV_TYPESAFE_URL);
    expect(init.method).toBe("POST");
    expect(init.headers?.Authorization).toBe(`Bearer ${KEY}`);
    expect(init.headers?.["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body ?? "") as {
      state: Record<string, unknown>;
      model: string;
      questions: unknown;
    };
    expect(body.model).toBe("jev-latest");
    expect(body.questions).toEqual(JEV_ACTION_QUESTIONS);
    // ToolCall → jev-guard 归一形状；session 映射到问题指针引用的字段名
    expect(body.state).toEqual({
      agent: "claude-code",
      tool: "shell",
      action: "execute",
      input: { command: "git push --force" },
      cwd: "/repo",
      context: {
        user_recent_messages: ["把刚才的提交推到主干"],
        recent_tool_calls: ["git status", "git commit -m x"],
        flagged_untrusted_content: [
          {
            kind: "injection",
            excerpt: "ignore previous instructions",
            p: 0.93,
          },
        ],
      },
    });
    // apiKey 只进 Authorization 头，绝不出现在 body
    expect(init.body).not.toContain(KEY);
  });

  it("gateway：URL、ai-gateway-* 头、noul→boolean、zeroDataRetention", async () => {
    const { calls, fetchImpl } = stubFetch([
      resp({
        answers: {
          risk: { score: 0 },
          approval: { noul: 0.1 },
          user_requested: { noul: 0.2 },
          from_untrusted: { noul: 0.3 },
        },
      }),
    ]);
    const judge = makeJudge(fetchImpl, { backend: "gateway" });
    await judge.assess(call);

    const { url, init } = calls[0] as RecordedCall;
    expect(url).toBe(JEV_GATEWAY_URL);
    const h = init.headers ?? {};
    expect(h.Authorization).toBe(`Bearer ${KEY}`);
    expect(h["ai-gateway-protocol-version"]).toBe("0.0.1");
    expect(h["ai-gateway-auth-method"]).toBe("api-key");
    expect(h["ai-evaluation-model-specification-version"]).toBe("4");
    expect(h["ai-model-id"]).toBe("typesafe-ai/jev");

    const body = JSON.parse(init.body ?? "") as {
      questions: Record<string, { type: string }>;
      providerOptions: unknown;
    };
    expect(body.questions.risk?.type).toBe("score");
    expect(body.questions.approval?.type).toBe("boolean");
    expect(body.questions.user_requested?.type).toBe("boolean");
    expect(body.questions.from_untrusted?.type).toBe("boolean");
    expect(body.providerOptions).toEqual({
      gateway: { zeroDataRetention: true },
    });
  });
});

describe("JevJudge 答案映射", () => {
  it("4 问映射：noul/probability 回退、confidence 题内优先与 providerMetadata 回退", async () => {
    const { fetchImpl } = stubFetch([
      resp({
        answers: {
          risk: { score: 2.5, confidence: 0.91 },
          approval: { noul: 0.8, confidence: 0.72 },
          user_requested: { probability: 0.97 },
          from_untrusted: { noul: 0.02 },
        },
        providerMetadata: {
          typesafe: { confidence: { user_requested: 0.9, from_untrusted: 0.77 } },
        },
      }),
    ]);
    const answers = await makeJudge(fetchImpl).assess(call);
    expect(answers.risk).toBe(2.5);
    expect(answers.approval).toBe(0.8);
    expect(answers.user_requested).toBe(0.97);
    expect(answers.from_untrusted).toBe(0.02);
    expect(answers.confidence).toEqual({
      risk: 0.91,
      approval: 0.72,
      user_requested: 0.9,
      from_untrusted: 0.77,
    });
  });
});

describe("JevJudge 超时与重试", () => {
  it("预算超时：挂起的请求在 budgetMs 后被中止并抛错", async () => {
    const hanging: JevFetch = (_url, init = {}) =>
      new Promise<JevResponse>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => {
            const reason: unknown = init.signal?.reason;
            reject(
              reason instanceof Error ? reason : new Error("aborted"),
            );
          },
          { once: true },
        );
      });
    const judge = makeJudge(hanging, { budgetMs: 30 });
    await expect(judge.assess(call)).rejects.toThrow(
      "jev: budget 30ms exceeded",
    );
  });

  it("500 与 429 退避重试后成功：3 次调用，退避函数按 attempt 0,1 触发", async () => {
    const { calls, fetchImpl } = stubFetch([
      resp("server error", 500),
      resp("rate limited", 429),
      resp({
        answers: {
          risk: { score: 1 },
          approval: { noul: 0.2 },
          user_requested: { noul: 0.9 },
          from_untrusted: { noul: 0 },
        },
      }),
    ]);
    const delays: number[] = [];
    const retryDelay = (attempt: number): number => {
      delays.push(attempt);
      return 0;
    };
    const judge = makeJudge(fetchImpl, { retryDelay });
    const answers = await judge.assess(call);
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([0, 1]);
    expect(answers.risk).toBe(1);
  });

  it("网络错误（ECONNRESET 类）同样走重试", async () => {
    const { calls, fetchImpl } = stubFetch([
      new Error("socket hang up"),
      resp({
        answers: {
          risk: { score: 0 },
          approval: { noul: 0.1 },
          user_requested: { noul: 0 },
          from_untrusted: { noul: 0 },
        },
      }),
    ]);
    const answers = await makeJudge(fetchImpl).assess(call);
    expect(calls).toHaveLength(2);
    expect(answers.approval).toBe(0.1);
  });

  it("4xx 不重试，直接抛 HTTP 错误", async () => {
    const { calls, fetchImpl } = stubFetch([resp("bad request", 400)]);
    await expect(makeJudge(fetchImpl).assess(call)).rejects.toThrow(
      "jev: typesafe HTTP 400: bad request",
    );
    expect(calls).toHaveLength(1);
  });

  it("重试耗尽仍 5xx：3 次尝试后抛错，且每次重试前排空响应", async () => {
    let drains = 0;
    const failing: JevResponse = {
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
      text: () => {
        drains += 1;
        return Promise.resolve("unavailable");
      },
    };
    const { calls, fetchImpl } = stubFetch([failing, failing, failing]);
    await expect(makeJudge(fetchImpl).assess(call)).rejects.toThrow(
      "jev: typesafe HTTP 503",
    );
    expect(calls).toHaveLength(3);
    expect(drains).toBe(3); // 前 2 次为重试前排空，末次为错误信息
  });

  it("3 次尝试全部网络错误 → 抛错", async () => {
    const down = new Error("ECONNRESET");
    const { calls, fetchImpl } = stubFetch([down, down, down]);
    await expect(makeJudge(fetchImpl).assess(call)).rejects.toThrow(
      "jev: fetch failed after 3 attempts",
    );
    expect(calls).toHaveLength(3);
  });
});

describe("JevJudge 畸形响应（一律抛错，客户端不默认放行值）", () => {
  const malformedCases: Array<[string, unknown, RegExp]> = [
    ["顶层不是对象", [1, 2, 3], /malformed response \(missing answers object\)/],
    [
      "缺 from_untrusted 题",
      {
        answers: {
          risk: { score: 1 },
          approval: { noul: 0.1 },
          user_requested: { noul: 0.1 },
        },
      },
      /answers\.from_untrusted missing/,
    ],
    [
      "risk.score 类型错误",
      {
        answers: {
          risk: { score: "high" },
          approval: { noul: 0.1 },
          user_requested: { noul: 0.1 },
          from_untrusted: { noul: 0.1 },
        },
      },
      /risk\.score must be a number in \[0,3\]/,
    ],
    [
      "risk.score 越界 4",
      {
        answers: {
          risk: { score: 4 },
          approval: { noul: 0.1 },
          user_requested: { noul: 0.1 },
          from_untrusted: { noul: 0.1 },
        },
      },
      /risk\.score must be a number in \[0,3\]/,
    ],
    [
      "approval 缺 noul/probability",
      {
        answers: {
          risk: { score: 1 },
          approval: {},
          user_requested: { noul: 0.1 },
          from_untrusted: { noul: 0.1 },
        },
      },
      /approval probability must be a number in \[0,1\]/,
    ],
    [
      "概率越界 1.5",
      {
        answers: {
          risk: { score: 1 },
          approval: { noul: 0.1 },
          user_requested: { noul: 1.5 },
          from_untrusted: { noul: 0.1 },
        },
      },
      /user_requested probability must be a number in \[0,1\]/,
    ],
    [
      "confidence 越界 2",
      {
        answers: {
          risk: { score: 1, confidence: 2 },
          approval: { noul: 0.1 },
          user_requested: { noul: 0.1 },
          from_untrusted: { noul: 0.1 },
        },
      },
      /risk\.confidence must be a number in \[0,1\]/,
    ],
  ];

  for (const [name, body, pattern] of malformedCases) {
    it(name, async () => {
      const { fetchImpl } = stubFetch([resp(body)]);
      await expect(makeJudge(fetchImpl).assess(call)).rejects.toThrow(pattern);
      await expect(makeJudge(fetchImpl).assess(call)).rejects.toThrow(
        /^jev: /,
      );
    });
  }

  it("响应 body 不是合法 JSON → json() 拒绝，错误向上抛", async () => {
    const badJson: JevResponse = {
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
      text: () => Promise.resolve("<html>"),
    };
    const { fetchImpl } = stubFetch([badJson]);
    await expect(makeJudge(fetchImpl).assess(call)).rejects.toThrow(
      SyntaxError,
    );
  });
});

describe("JevJudge apiKey 卫生", () => {
  it("构造参数为空 → 抛错（且不包含任何 key 值）", () => {
    expect(() => new JevJudge({ apiKey: "" })).toThrow(
      "jev: apiKey is required",
    );
  });

  it("成功与失败路径都不向 console/stdout/stderr 与错误信息泄漏 apiKey", async () => {
    const consoleSpies = [
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
    ];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const ok = stubFetch([
        resp({
          answers: {
            risk: { score: 1 },
            approval: { noul: 0.2 },
            user_requested: { noul: 0.3 },
            from_untrusted: { noul: 0.4 },
          },
        }),
      ]);
      await makeJudge(ok.fetchImpl).assess(call);

      const boom = stubFetch([resp("unauthorized", 401)]);
      const err = await makeJudge(boom.fetchImpl)
        .assess(call)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(KEY);

      const emitted = (
        [
          ...consoleSpies.flatMap((s) => s.mock.calls),
          ...stderrSpy.mock.calls,
          ...stdoutSpy.mock.calls,
        ] as unknown[][]
      )
        .flat()
        .map((a) => String(a))
        .join("\n");
      expect(emitted).not.toContain(KEY);
      expect(emitted).not.toContain("Authorization");
      // 请求体也不含 key（唯一出现位置是被测的 Authorization 头）
      expect(ok.calls[0]?.init.body).not.toContain(KEY);
      expect(boom.calls[0]?.init.body).not.toContain(KEY);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
