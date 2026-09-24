import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolCall } from "../api/types.js";
import {
  AuditLogWriter,
  AuditQueue,
  type AuditRecord,
  type BackpressureMode,
} from "../audit/index.js";
import type { Judge, JudgeAnswers } from "../judge/index.js";
import { createPolicyEngine, loadPolicyFile } from "../policy/index.js";
import { loadRules } from "../rules/loader.js";
import { createEngine, type AclConfig, type Engine, type JudgeOptions } from "./index.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const rules = loadRules(path.join(REPO_ROOT, "rules"));
const policyConfig = loadPolicyFile(path.join(REPO_ROOT, "policies", "default.yaml"));

const tmp = mkdtempSync(path.join(tmpdir(), "agentfence-engine-"));
let auditSeq = 0;

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface EngineFixture {
  engine: Engine;
  auditPath: string;
  readRecords: () => AuditRecord[];
}

function makeEngine(options?: {
  acl?: AclConfig;
  judge?: JudgeOptions;
  auditMode?: BackpressureMode;
  auditCapacity?: number;
}): EngineFixture {
  auditSeq += 1;
  const auditPath = path.join(tmp, `audit-${String(auditSeq)}.jsonl`);
  const audit = new AuditQueue({
    writer: new AuditLogWriter(auditPath),
    mode: options?.auditMode ?? "best_effort",
    ...(options?.auditCapacity !== undefined ? { capacity: options.auditCapacity } : {}),
  });
  const engine = createEngine({
    rules,
    policy: createPolicyEngine(policyConfig),
    policyVersion: `policy-v${String(policyConfig.version)}`,
    ...(options?.acl !== undefined ? { acl: options.acl } : {}),
    ...(options?.judge !== undefined ? { judge: options.judge } : {}),
    audit,
  });
  return {
    engine,
    auditPath,
    readRecords: () =>
      readFileSync(auditPath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as AuditRecord),
  };
}

function shellCall(command: string, overrides?: Partial<ToolCall>): ToolCall {
  return {
    request_id: "req_test",
    agent_id: "vitest",
    tool: { name: "shell", action: "execute", category: "shell" },
    input: { command },
    ...overrides,
  };
}

function fakeJudge(answers: JudgeAnswers): Judge {
  return { assess: () => Promise.resolve(answers) };
}

const CALM: JudgeAnswers = { risk: 0, approval: 0, user_requested: 0, from_untrusted: 0 };
const DEADLY: JudgeAnswers = { risk: 3, approval: 0, user_requested: 0, from_untrusted: 0 };

describe("engine 管线编排", () => {
  describe("ACL 层", () => {
    it("agent 工具开关 allowed:false → DENY（decision_layer: acl）", async () => {
      const { engine } = makeEngine({
        acl: { agents: { research: { tools: { shell: { allowed: false } } } } },
      });
      const decision = await engine.check(shellCall("ls", { agent_id: "research" }));
      expect(decision.decision).toBe("DENY");
      expect(decision.decision_layer).toBe("acl");
      await engine.close();
    });

    it("白名单不含该工具 → DENY；在白名单内 → 放行到后续层", async () => {
      const { engine } = makeEngine({ acl: { default: { allow: ["fs"] } } });
      const denied = await engine.check(shellCall("ls"));
      expect(denied.decision).toBe("DENY");
      expect(denied.decision_layer).toBe("acl");

      const allowed = await engine.check(
        shellCall("ls", { tool: { name: "fs", action: "read" } }),
      );
      expect(allowed.decision).toBe("ALLOW");
      await engine.close();
    });

    it("黑名单优先于白名单", async () => {
      const { engine } = makeEngine({
        acl: { default: { allow: ["shell"], deny: ["shell"] } },
      });
      const decision = await engine.check(shellCall("ls"));
      expect(decision.decision).toBe("DENY");
      expect(decision.decision_layer).toBe("acl");
      await engine.close();
    });

    it("agent 未配置且无 default → 无 ACL 限制", async () => {
      const { engine } = makeEngine({ acl: { agents: { other: { deny: ["shell"] } } } });
      const decision = await engine.check(shellCall("ls"));
      expect(decision.decision).toBe("ALLOW");
      await engine.close();
    });
  });

  describe("Parser 层", () => {
    it("解析失败 → fail-closed DENY（decision_layer: parser）", async () => {
      const { engine } = makeEngine();
      const decision = await engine.check(shellCall("ls '"));
      expect(decision.decision).toBe("DENY");
      expect(decision.decision_layer).toBe("parser");
      expect(decision.reason).toContain("fail-closed");
      await engine.close();
    });

    it("shell 工具缺少 string 类型 input.command → fail-closed DENY", async () => {
      const { engine } = makeEngine();
      const decision = await engine.check(shellCall("", { input: {} }));
      expect(decision.decision).toBe("DENY");
      expect(decision.decision_layer).toBe("parser");
      await engine.close();
    });
  });

  describe("Rules 层", () => {
    it("命中 DENY 规则 → 短路（decision_layer: rules，matched_rules 带 id）", async () => {
      const { engine } = makeEngine();
      const decision = await engine.check(shellCall("rm -rf /"));
      expect(decision.decision).toBe("DENY");
      expect(decision.decision_layer).toBe("rules");
      expect(decision.matched_rules).toContain("fs.rm-recursive-guarded-path");
      expect(decision.risk).toBe("CRITICAL");
      await engine.close();
    });

    it("命中 REVIEW 规则 → 短路 REVIEW", async () => {
      const { engine } = makeEngine();
      const decision = await engine.check(shellCall("fdisk /dev/sda"));
      expect(decision.decision).toBe("REVIEW");
      expect(decision.decision_layer).toBe("rules");
      expect(decision.matched_rules.length).toBeGreaterThan(0);
      await engine.close();
    });
  });

  describe("Policy 层", () => {
    it("rules 无命中但策略命中 → 短路（decision_layer: policy）", async () => {
      const { engine } = makeEngine();
      // "ls" 不命中任何规则；action=delete + target=production 命中策略规则
      const decision = await engine.check(
        shellCall("ls", {
          tool: { name: "shell", action: "delete", category: "shell" },
          context: { target: "production" },
        }),
      );
      expect(decision.decision).toBe("DENY");
      expect(decision.decision_layer).toBe("policy");
      expect(decision.reason).toContain("policy.production.destructive-agent");
      expect(decision.policy_version).toBe("policy-v1");
      await engine.close();
    });

    it("策略给出确定 ALLOW → 落定 ALLOW，不进 judge", async () => {
      let judgeCalled = false;
      const spyJudge: Judge = {
        assess: () => {
          judgeCalled = true;
          return Promise.resolve(DEADLY);
        },
      };
      const { engine } = makeEngine({ judge: { enabled: true, judge: spyJudge } });
      // action=read 命中 policy.read.recon（ALLOW）
      const decision = await engine.check(
        shellCall("ls", { tool: { name: "shell", action: "read", category: "shell" } }),
      );
      expect(decision.decision).toBe("ALLOW");
      expect(decision.decision_layer).toBe("policy");
      expect(judgeCalled).toBe(false);
      await engine.close();
    });
  });

  describe("indirect 启发式（parser 及格线第 3 条的判定层消费）", () => {
    it("任一子命令 indirect 且前面各层无结论 → REVIEW（HIGH/0.8/meta.indirect-execution）", async () => {
      const { engine } = makeEngine();
      const decision = await engine.check(shellCall("cat cmds.txt | xargs sh"));
      expect(decision.decision).toBe("REVIEW");
      expect(decision.risk).toBe("HIGH");
      expect(decision.confidence).toBe(0.8);
      expect(decision.decision_layer).toBe("rules");
      expect(decision.matched_rules).toEqual(["meta.indirect-execution"]);
      await engine.close();
    });

    it("无 indirect 迹象 → 不触发，仍落默认 ALLOW", async () => {
      const { engine } = makeEngine();
      const decision = await engine.check(shellCall("cat app.log | grep -i error"));
      expect(decision.decision).toBe("ALLOW");
      expect(decision.matched_rules).toEqual([]);
      await engine.close();
    });

    it("deny-overrides：载荷展开命中 DENY 规则 → 规则层短路，启发式不抢", async () => {
      const { engine } = makeEngine();
      const decision = await engine.check(shellCall("bash -c 'rm -rf /'"));
      expect(decision.decision).toBe("DENY");
      expect(decision.decision_layer).toBe("rules");
      expect(decision.matched_rules).toContain("fs.rm-recursive-guarded-path");
      expect(decision.matched_rules).not.toContain("meta.indirect-execution");
      await engine.close();
    });

    it("明确规则 REVIEW 同样优先于启发式", async () => {
      const { engine } = makeEngine();
      const decision = await engine.check(shellCall("bash -c 'fdisk /dev/sda'"));
      expect(decision.decision).toBe("REVIEW");
      expect(decision.decision_layer).toBe("rules");
      expect(decision.matched_rules).not.toEqual(["meta.indirect-execution"]);
      await engine.close();
    });

    it("policy DENY 结论压制启发式（decision_layer: policy）", async () => {
      const { engine } = makeEngine();
      const decision = await engine.check(
        shellCall("cat cmds.txt | xargs sh", {
          tool: { name: "shell", action: "delete", category: "shell" },
          context: { target: "production" },
        }),
      );
      expect(decision.decision).toBe("DENY");
      expect(decision.decision_layer).toBe("policy");
      expect(decision.matched_rules).toEqual([]);
      await engine.close();
    });

    it("policy 确定 ALLOW 落定，不再触发启发式", async () => {
      const { engine } = makeEngine();
      const decision = await engine.check(
        shellCall("bash /tmp/deploy.sh", {
          tool: { name: "shell", action: "read", category: "shell" },
        }),
      );
      expect(decision.decision).toBe("ALLOW");
      expect(decision.decision_layer).toBe("policy");
      await engine.close();
    });

    it("judge 启用时启发式仍先行：indirect 灰区不调 judge", async () => {
      let judgeCalled = false;
      const spyJudge: Judge = {
        assess: () => {
          judgeCalled = true;
          return Promise.resolve(CALM);
        },
      };
      const { engine } = makeEngine({ judge: { enabled: true, judge: spyJudge } });
      const decision = await engine.check(shellCall("cat cmds.txt | xargs sh"));
      expect(decision.decision).toBe("REVIEW");
      expect(decision.decision_layer).toBe("rules");
      expect(judgeCalled).toBe(false);
      await engine.close();
    });

    it("reason 指出子命令序号、可执行位与间接形态", async () => {
      const { engine } = makeEngine();
      const xargs = await engine.check(shellCall("cat cmds.txt | xargs sh"));
      expect(xargs.reason).toContain("#2");
      expect(xargs.reason).toContain("xargs");
      expect(xargs.reason).toContain("间接执行");

      const pipedSh = await engine.check(shellCall("echo xxx | base64 -d | sh"));
      expect(pipedSh.reason).toContain("#3");
      expect(pipedSh.reason).toContain("`sh`");
      expect(pipedSh.reason).toContain("stdin");
      expect(pipedSh.reason).toContain("载荷不可见");

      const scriptFile = await engine.check(shellCall("bash /tmp/deploy.sh"));
      expect(scriptFile.reason).toContain("`bash`");
      expect(scriptFile.reason).toContain("脚本文件");

      const varIndirect = await engine.check(shellCall('CMD="terraform destroy"; $CMD'));
      expect(varIndirect.reason).toContain("$CMD");
      expect(varIndirect.reason).toContain("变量/命令替换");
      await engine.close();
    });
  });

  describe("Judge 层", () => {
    it("默认配置 judge 关闭：灰区默认 ALLOW 且不调用 judge", async () => {
      const { engine, readRecords } = makeEngine();
      const decision = await engine.check(shellCall("ls"));
      expect(decision.decision).toBe("ALLOW");
      expect(decision.decision_layer).toBe("policy");
      await engine.close();
      const records = readRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.judge_used).toBe(false);
    });

    it("enabled:true 且灰区 → 调用 judge，按 decide 阈值出结论", async () => {
      const { engine, readRecords } = makeEngine({
        judge: { enabled: true, judge: fakeJudge(DEADLY) },
      });
      const decision = await engine.check(shellCall("ls"));
      expect(decision.decision).toBe("DENY");
      expect(decision.decision_layer).toBe("judge");
      expect(decision.risk).toBe("CRITICAL");
      await engine.close();
      expect(readRecords()[0]?.judge_used).toBe(true);
    });

    it("judge 低危答案 → ALLOW（decision_layer: judge）", async () => {
      const { engine } = makeEngine({ judge: { enabled: true, judge: fakeJudge(CALM) } });
      const decision = await engine.check(shellCall("ls"));
      expect(decision.decision).toBe("ALLOW");
      expect(decision.decision_layer).toBe("judge");
      await engine.close();
    });

    it("judge 抛错 → fail_closed 默认 DENY", async () => {
      const broken: Judge = { assess: () => Promise.reject(new Error("boom")) };
      const { engine } = makeEngine({ judge: { enabled: true, judge: broken } });
      const decision = await engine.check(shellCall("ls"));
      expect(decision.decision).toBe("DENY");
      expect(decision.decision_layer).toBe("judge");
      expect(decision.reason).toContain("fail-closed");
      await engine.close();
    });

    it("judge 超时 → fail_closed DENY", async () => {
      const slow: Judge = {
        assess: () => new Promise<JudgeAnswers>(() => undefined),
      };
      const { engine } = makeEngine({
        judge: { enabled: true, judge: slow, timeout_ms: 50 },
      });
      const decision = await engine.check(shellCall("ls"));
      expect(decision.decision).toBe("DENY");
      expect(decision.decision_layer).toBe("judge");
      expect(decision.reason).toContain("超时");
      await engine.close();
    });

    it("judge 抛错且 fail_closed:false → ALLOW", async () => {
      const broken: Judge = { assess: () => Promise.reject(new Error("boom")) };
      const { engine } = makeEngine({
        judge: { enabled: true, judge: broken, fail_closed: false },
      });
      const decision = await engine.check(shellCall("ls"));
      expect(decision.decision).toBe("ALLOW");
      expect(decision.decision_layer).toBe("judge");
      await engine.close();
    });

    it("enabled:true 但未提供 Judge 实例 → 按 fail_closed 处理", async () => {
      const { engine } = makeEngine({ judge: { enabled: true } });
      const decision = await engine.check(shellCall("ls"));
      expect(decision.decision).toBe("DENY");
      expect(decision.decision_layer).toBe("judge");
      await engine.close();
    });
  });

  describe("Audit 层", () => {
    it("ALLOW 与 DENY 都写审计，字段完整", async () => {
      const { engine, readRecords } = makeEngine();
      const allow = await engine.check(shellCall("ls"));
      const deny = await engine.check(shellCall("rm -rf /"));
      expect(allow.decision).toBe("ALLOW");
      expect(deny.decision).toBe("DENY");
      await engine.close();

      const records = readRecords();
      expect(records).toHaveLength(2);
      expect(records.map((r) => r.decision)).toEqual(["ALLOW", "DENY"]);
      expect(records.map((r) => r.decision_layer)).toEqual(["policy", "rules"]);
      for (const record of records) {
        expect(record.agent_id).toBe("vitest");
        expect(record.tool).toBe("shell");
        expect(record.input_digest).toMatch(/^sha256:/);
        expect(record.policy_version).toBe("policy-v1");
        expect(typeof record.latency_ms).toBe("number");
      }
      expect(records[1]?.matched_rules).toContain("fs.rm-recursive-guarded-path");
    });

    it("fail_closed 背压：审计入队失败时 ALLOW 被改写为 DENY", async () => {
      const { engine } = makeEngine({ auditMode: "fail_closed", auditCapacity: 0 });
      const decision = await engine.check(shellCall("ls"));
      expect(decision.decision).toBe("DENY");
      expect(decision.reason).toContain("audit fail-closed");
      await engine.close();
    });
  });
});
