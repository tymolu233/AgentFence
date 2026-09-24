import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { loadRules } from "./loader.js";
import { evaluateToolCall } from "./matcher.js";
import { sh, shellCall } from "./fixtures.js";

const RULES_DIR = fileURLToPath(new URL("../../rules/", import.meta.url));
const rules = loadRules(RULES_DIR);

describe("内置规则库（rules/*.yaml）", () => {
  it("加载 43 条规则，id 唯一，按 priority 升序", () => {
    expect(rules).toHaveLength(43);
    expect(new Set(rules.map((r) => r.id)).size).toBe(43);
    for (let i = 1; i < rules.length; i++) {
      const prev = rules[i - 1];
      const curr = rules[i];
      expect(curr && prev && curr.priority >= prev.priority).toBe(true);
    }
  });

  it("覆盖 8 个类目", () => {
    const categories = new Set<string>(rules.map((r) => r.category));
    for (const c of ["shell", "filesystem", "database", "cloud", "kubernetes", "git", "iac", "network"]) {
      expect(categories.has(c), `缺少类目 ${c}`).toBe(true);
    }
  });

  it("每条规则都带 deny/allow 样例与 refs", () => {
    for (const rule of rules) {
      expect(rule.tests.deny.length, `${rule.id} 缺 tests.deny`).toBeGreaterThan(0);
      expect(rule.tests.allow.length, `${rule.id} 缺 tests.allow`).toBeGreaterThan(0);
      expect(rule.refs.length, `${rule.id} 缺 refs`).toBeGreaterThan(0);
    }
  });

  describe("规则自带 tests 样例（规则即规格）", () => {
    for (const rule of rules) {
      describe(rule.id, () => {
        for (const sample of rule.tests.deny) {
          it(`deny: ${sample}`, () => {
            const verdict = evaluateToolCall(rules, shellCall(sample), sh(sample));
            expect(verdict, `应命中 ${rule.id}`).toBeDefined();
            expect(verdict?.matched_rules).toContain(rule.id);
            expect(verdict?.decision).toBe(rule.action);
          });
        }
        for (const sample of rule.tests.allow) {
          it(`allow: ${sample}`, () => {
            const verdict = evaluateToolCall(rules, shellCall(sample), sh(sample));
            expect(verdict, `不应命中任何规则：${verdict?.matched_rules.join(",") ?? ""}`).toBeUndefined();
          });
        }
      });
    }
  });
});
