/**
 * 规则质量语料库评测门禁（任务 D1：误拦率/漏拦率的 CI 回归指标）。
 *
 * 用真实 createEngine（仓库 rules/ + policies/default.yaml，审计落临时目录）
 * 对 tests/corpus/{benign,adversarial}.yaml 逐条跑 engine.check，产出：
 *   - 良性语料门禁：DENY = 0（REVIEW 允许但计数并逐条上报）；
 *   - 对抗语料门禁：每条按 expect 断言（NOT_ALLOW = 不得 ALLOW），
 *     当前引擎无法识别的漏拦条目登记在 KNOWN_MISSES 豁免清单——
 *     保持 expect 的正确安全语义，不迁就现状；
 *   - 混乱矩阵与规则命中覆盖报告（console 输出，不落文件）。
 *
 * 豁免清单语义是"已知漏拦"，不是"预期行为"：条目一旦开始满足 expect，
 * 套件即红并提示从清单移除——清单必须始终精确反映当前漏拦面。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { Decision, DecisionKind, ToolCall } from "../../src/api/types.js";
import { AuditLogWriter, AuditQueue } from "../../src/audit/index.js";
import { createEngine, type Engine } from "../../src/engine/index.js";
import { createPolicyEngine, loadPolicyFile } from "../../src/policy/index.js";
import { loadRules } from "../../src/rules/loader.js";
import type { Rule } from "../../src/rules/schema.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BENIGN_PATH = path.join(REPO_ROOT, "tests", "corpus", "benign.yaml");
const ADVERSARIAL_PATH = path.join(REPO_ROOT, "tests", "corpus", "adversarial.yaml");

// ---------------------------------------------------------------------------
// 语料类型与加载校验
// ---------------------------------------------------------------------------

type ExpectKind = "ALLOW" | "REVIEW" | "DENY" | "NOT_ALLOW";
const EXPECT_KINDS: readonly ExpectKind[] = ["ALLOW", "REVIEW", "DENY", "NOT_ALLOW"];
const DECISION_KINDS: readonly DecisionKind[] = ["ALLOW", "REVIEW", "DENY"];

interface BenignEntry {
  cmd: string;
  comment?: string;
}

interface AdversarialEntry {
  id: string;
  cmd: string;
  expect: ExpectKind;
  comment?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadBenign(file: string): BenignEntry[] {
  const raw: unknown = parseYaml(readFileSync(file, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${file}：顶层必须是数组`);
  return raw.map((item: unknown, index: number): BenignEntry => {
    if (!isRecord(item) || typeof item.cmd !== "string" || item.cmd.trim() === "") {
      throw new Error(`${file}：第 ${String(index)} 条缺少非空 string 类型 cmd 字段`);
    }
    if (item.comment !== undefined && typeof item.comment !== "string") {
      throw new Error(`${file}：第 ${String(index)} 条 comment 必须是 string`);
    }
    return item.comment !== undefined
      ? { cmd: item.cmd, comment: item.comment }
      : { cmd: item.cmd };
  });
}

function loadAdversarial(file: string): AdversarialEntry[] {
  const raw: unknown = parseYaml(readFileSync(file, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${file}：顶层必须是数组`);
  const seen = new Set<string>();
  return raw.map((item: unknown, index: number): AdversarialEntry => {
    if (!isRecord(item)) throw new Error(`${file}：第 ${String(index)} 条必须是对象`);
    const where = `${file}：第 ${String(index)} 条（id=${String(item.id)}）`;
    if (typeof item.id !== "string" || item.id.trim() === "") {
      throw new Error(`${where}：缺少非空 string 类型 id 字段`);
    }
    if (seen.has(item.id)) throw new Error(`${where}：id 重复`);
    seen.add(item.id);
    if (typeof item.cmd !== "string" || item.cmd.trim() === "") {
      throw new Error(`${where}：缺少非空 string 类型 cmd 字段`);
    }
    if (typeof item.expect !== "string" || !EXPECT_KINDS.includes(item.expect as ExpectKind)) {
      throw new Error(`${where}：expect 必须是 ${EXPECT_KINDS.join(" / ")}`);
    }
    if (item.comment !== undefined && typeof item.comment !== "string") {
      throw new Error(`${where}：comment 必须是 string`);
    }
    return {
      id: item.id,
      cmd: item.cmd,
      expect: item.expect as ExpectKind,
      ...(item.comment !== undefined ? { comment: item.comment } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// 已知漏拦豁免清单：当前引擎判 ALLOW 但正确安全语义是不放行的条目。
// 每条给出根因；条目开始满足 expect 时套件会变红，提示从此清单移除。
// ---------------------------------------------------------------------------
const KNOWN_MISSES: Readonly<Record<string, string>> = {
  "byp-heredoc-sh": "heredoc 载荷在重定向内，不进 token 流；sh 无 -c 不标 indirect（待 parser：redirects.stdin 存在即标 indirect）",
  "byp-make-destroy": "配置外置（A6-5 自承认盲区）：Makefile 语义不在命令字符串里；属环境维度信号，规则层之外",
};

// ---------------------------------------------------------------------------
// 评测夹具：真实 createEngine + 仓库 rules/ + policies/default.yaml
// ---------------------------------------------------------------------------

const rules: readonly Rule[] = loadRules(path.join(REPO_ROOT, "rules"));

interface RunRecord {
  cmd: string;
  decision: DecisionKind;
  matched: string[];
  layer: Decision["decision_layer"];
  reason: string;
}

let tmpDir = "";
let engine: Engine;
let benign: BenignEntry[] = [];
let adversarial: AdversarialEntry[] = [];
const benignRuns: RunRecord[] = [];
const adversarialRuns = new Map<string, RunRecord>();

function shellCall(command: string, seq: number): ToolCall {
  return {
    request_id: `req_corpus_${String(seq)}`,
    agent_id: "corpus-eval",
    tool: { name: "shell", action: "execute", category: "shell" },
    input: { command },
  };
}

async function runCheck(command: string, seq: number): Promise<RunRecord> {
  const decision = await engine.check(shellCall(command, seq));
  return {
    cmd: command,
    decision: decision.decision,
    matched: decision.matched_rules,
    layer: decision.decision_layer,
    reason: decision.reason,
  };
}

beforeAll(async () => {
  benign = loadBenign(BENIGN_PATH);
  adversarial = loadAdversarial(ADVERSARIAL_PATH);
  tmpDir = mkdtempSync(path.join(tmpdir(), "agentfence-corpus-"));
  const audit = new AuditQueue({
    writer: new AuditLogWriter(path.join(tmpDir, "audit.jsonl")),
    mode: "best_effort",
  });
  const policyConfig = loadPolicyFile(path.join(REPO_ROOT, "policies", "default.yaml"));
  engine = createEngine({
    rules,
    policy: createPolicyEngine(policyConfig),
    policyVersion: `policy-v${String(policyConfig.version)}`,
    audit,
  });
  let seq = 0;
  for (const entry of benign) {
    seq += 1;
    benignRuns.push(await runCheck(entry.cmd, seq));
  }
  for (const entry of adversarial) {
    seq += 1;
    adversarialRuns.set(entry.id, await runCheck(entry.cmd, seq));
  }
});

// ---------------------------------------------------------------------------
// 判定语义与统计
// ---------------------------------------------------------------------------

function expectationSatisfied(expectation: ExpectKind, actual: DecisionKind): boolean {
  switch (expectation) {
    case "ALLOW":
      return actual === "ALLOW";
    case "DENY":
      return actual === "DENY";
    case "REVIEW":
      return actual === "REVIEW";
    case "NOT_ALLOW":
      return actual !== "ALLOW";
  }
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function buildReport(): string {
  const lines: string[] = [];
  const hitCount = new Map<string, number>();
  for (const run of [...benignRuns, ...adversarialRuns.values()]) {
    for (const id of run.matched) hitCount.set(id, (hitCount.get(id) ?? 0) + 1);
  }

  lines.push("", "========== 语料评测报告（D1） ==========");
  lines.push(`良性语料 ${String(benignRuns.length)} 条 / 对抗语料 ${String(adversarialRuns.size)} 条 / 规则总数 ${String(rules.length)} 条`);

  // 良性：决策分布
  const benignCount = new Map<DecisionKind, number>(DECISION_KINDS.map((k) => [k, 0]));
  for (const run of benignRuns) benignCount.set(run.decision, (benignCount.get(run.decision) ?? 0) + 1);
  lines.push(
    "",
    `[良性] 决策分布：${DECISION_KINDS.map((k) => `${k}=${String(benignCount.get(k) ?? 0)}`).join("  ")}（门禁：DENY = 0）`,
  );
  const benignReviews = benignRuns.filter((r) => r.decision === "REVIEW");
  if (benignReviews.length > 0) {
    lines.push("[良性] REVIEW 明细（允许但计入误拦成本）:");
    for (const run of benignReviews) {
      lines.push(`  - ${run.cmd}    命中: ${run.matched.join(", ")}（${run.layer}）`);
    }
  }

  // 对抗：expect × actual 混乱矩阵
  const kinds: ExpectKind[] = ["DENY", "REVIEW", "NOT_ALLOW", "ALLOW"];
  const matrix = new Map<string, number>();
  const failures: { entry: AdversarialEntry; run: RunRecord }[] = [];
  for (const entry of adversarial) {
    const run = adversarialRuns.get(entry.id);
    if (run === undefined) continue;
    const key = `${entry.expect} -> ${run.decision}`;
    matrix.set(key, (matrix.get(key) ?? 0) + 1);
    if (!expectationSatisfied(entry.expect, run.decision)) failures.push({ entry, run });
  }
  lines.push("", "[对抗] 混乱矩阵（期望 -> 实际）:");
  for (const expectation of kinds) {
    const cells = DECISION_KINDS.map(
      (actual) => `${actual}=${String(matrix.get(`${expectation} -> ${actual}`) ?? 0)}`,
    ).join("  ");
    lines.push(`  ${pad(expectation, 10)} ${cells}`);
  }

  const unexpected = failures.filter(({ entry }) => KNOWN_MISSES[entry.id] === undefined);
  const knownMisses = failures.filter(({ entry }) => KNOWN_MISSES[entry.id] !== undefined);
  lines.push("", `[对抗] 未登记豁免的期望不符：${String(unexpected.length)} 条`);
  for (const { entry, run } of unexpected) {
    lines.push(`  - ${entry.id}\texpect=${entry.expect}\tactual=${run.decision}\t${entry.cmd}`);
  }
  lines.push("", `[对抗] 已知漏拦清单：${String(knownMisses.length)} 条（expect 保持正确安全语义，引擎当前漏拦）`);
  for (const { entry, run } of knownMisses) {
    lines.push(`  - ${entry.id}\tactual=${run.decision}\t根因: ${KNOWN_MISSES[entry.id] ?? ""}\t${entry.cmd.replaceAll("\n", " \\n ")}`);
  }

  // 规则覆盖
  const hits = rules.filter((rule) => hitCount.has(rule.id));
  const zeroHit = rules.filter((rule) => !hitCount.has(rule.id));
  lines.push("", `[覆盖] 命中过的规则：${String(hits.length)} 条`);
  for (const rule of hits) {
    lines.push(`  - ${rule.id}\t命中 ${String(hitCount.get(rule.id) ?? 0)} 次`);
  }
  lines.push(`[覆盖] 零命中规则：${String(zeroHit.length)} 条（语料未触达，建议补样例或确认冗余）`);
  for (const rule of zeroHit) lines.push(`  - ${rule.id}`);
  lines.push("==========================================", "");
  return lines.join("\n");
}

afterAll(async () => {
  if (engine !== undefined) {
    console.log(buildReport());
    await engine.close();
  }
  if (tmpDir !== "") rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 门禁断言
// ---------------------------------------------------------------------------

describe("语料质量门禁", () => {
  it("语料规模与结构：良性 ≥150 条，对抗 ≥80 条，id 唯一", () => {
    expect(benign.length).toBeGreaterThanOrEqual(150);
    expect(adversarial.length).toBeGreaterThanOrEqual(80);
  });

  it("良性语料：DENY = 0", () => {
    const denied = benignRuns.filter((r) => r.decision === "DENY");
    const detail = denied
      .map((r) => `  - ${r.cmd}\n    命中: ${r.matched.join(", ")}（${r.layer}）${r.reason}`)
      .join("\n");
    expect(denied, `良性语料出现 ${String(denied.length)} 条 DENY：\n${detail}`).toHaveLength(0);
  });

  it("豁免清单保持精确：id 必须存在且当前确实漏拦", () => {
    const problems: string[] = [];
    for (const id of Object.keys(KNOWN_MISSES)) {
      const entry = adversarial.find((e) => e.id === id);
      if (entry === undefined) {
        problems.push(`- ${id}：豁免清单引用了不存在的语料条目`);
        continue;
      }
      const run = adversarialRuns.get(id);
      if (run !== undefined && expectationSatisfied(entry.expect, run.decision)) {
        problems.push(`- ${id}：引擎现在已满足 expect=${entry.expect}，请从豁免清单移除（误拦/漏拦面已改善）`);
      }
    }
    expect(problems, `豁免清单已过时：\n${problems.join("\n")}`).toHaveLength(0);
  });

  it("对抗语料：未豁免条目全部满足 expect", () => {
    const violations: string[] = [];
    for (const entry of adversarial) {
      if (KNOWN_MISSES[entry.id] !== undefined) continue;
      const run = adversarialRuns.get(entry.id);
      if (run === undefined) {
        violations.push(`- ${entry.id}: 未执行`);
        continue;
      }
      if (!expectationSatisfied(entry.expect, run.decision)) {
        violations.push(
          `- ${entry.id}: expect=${entry.expect} actual=${run.decision}（${run.layer}，命中 ${run.matched.join(", ") || "无"}）\n    cmd: ${entry.cmd.replaceAll("\n", " \\n ")}`,
        );
      }
    }
    expect(
      violations,
      `对抗语料 ${String(violations.length)} 条期望不符（若为真实漏拦请登记进豁免清单并注明根因）：\n${violations.join("\n")}`,
    ).toHaveLength(0);
  });

  it("覆盖报告：零命中规则已输出（见 console）", () => {
    // 覆盖统计在 afterAll 的报告中输出；此用例仅锚定"报告必然生成"
    expect(adversarialRuns.size).toBe(adversarial.length);
  });
});
