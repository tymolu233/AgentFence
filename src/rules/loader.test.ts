import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadRules, parseRuleFile, RuleLoadError } from "./loader.js";

const VALID = `
- id: test.ok
  category: shell
  severity: low
  action: REVIEW
  priority: 1
  match:
    argv0: [ls]
  refs: ["https://example.com"]
  tests:
    deny: ["ls -la /etc"]
    allow: ["ls"]
`;

function expectLoadError(yaml: string, pattern: RegExp): void {
  try {
    parseRuleFile(yaml, "bad.yaml");
    expect.unreachable("应当抛出 RuleLoadError");
  } catch (error) {
    expect(error).toBeInstanceOf(RuleLoadError);
    expect((error as Error).message).toMatch(pattern);
  }
}

describe("rules loader", () => {
  it("加载合法规则并解析全部字段", () => {
    const rules = parseRuleFile(VALID, "ok.yaml");
    expect(rules).toHaveLength(1);
    const rule = rules[0];
    expect(rule?.id).toBe("test.ok");
    expect(rule?.category).toBe("shell");
    expect(rule?.severity).toBe("low");
    expect(rule?.action).toBe("REVIEW");
    expect(rule?.priority).toBe(1);
    expect(rule?.match.argv0).toEqual(["ls"]);
    expect(rule?.source_file).toBe("ok.yaml");
  });

  it("闭集字段：非法 category / severity / action 均 fail-closed", () => {
    expectLoadError(VALID.replace("category: shell", "category: banana"), /闭集/);
    expectLoadError(VALID.replace("severity: low", "severity: fatal"), /闭集/);
    expectLoadError(VALID.replace("action: REVIEW", "action: ALLOW"), /闭集/);
  });

  it("priority 必须是非负整数", () => {
    expectLoadError(VALID.replace("priority: 1", "priority: -1"), /非负整数/);
    expectLoadError(VALID.replace("priority: 1", "priority: 1.5"), /非负整数/);
    expectLoadError(VALID.replace(/^ {2}priority: 1\n/m, ""), /非负整数/);
  });

  it("未知字段 fail-closed（规则级与 match 级）", () => {
    expectLoadError(VALID.replace("match:", "matc:"), /未知字段 "matc"/);
    expectLoadError(VALID.replace("argv0: [ls]", "argv00: [ls]"), /未知字段 "argv00"/);
  });

  it("正则必须是可编译的 /pattern/flags 字面量，flag 仅 i/s", () => {
    const withRegex = VALID.replace("argv0: [ls]", "args_regex: ['/DROP TABLE/']");
    expect(parseRuleFile(withRegex, "ok.yaml")[0]?.match.args_regex).toEqual(["/DROP TABLE/"]);
    expectLoadError(VALID.replace("argv0: [ls]", "args_regex: ['DROP TABLE']"), /字面量/);
    expectLoadError(VALID.replace("argv0: [ls]", "args_regex: ['/(/']"), /无法编译/);
    expectLoadError(VALID.replace("argv0: [ls]", "args_regex: ['/x/g']"), /仅允许/);
  });

  it("match 至少要有一个匹配子句；any 不允许嵌套", () => {
    expectLoadError(VALID.replace("argv0: [ls]", "{}"), /至少要有一个匹配子句/);
    const nested = VALID.replace(
      "argv0: [ls]",
      "any:\n      - argv0: [ls]\n        any:\n          - argv0: [sh]",
    );
    expectLoadError(nested, /不允许嵌套/);
  });

  it("重复规则 id / 重复 YAML 键 / 非法顶级结构均报错", () => {
    expectLoadError(VALID + VALID, /重复的规则 id/);
    expectLoadError(VALID.replace("refs:", "id: test.dup\n  refs:"), /YAML 解析失败/);
    expectLoadError("foo: bar\n", /顶级必须是规则数组/);
    expectLoadError("[]\n", /不能为空/);
  });

  it("refs / tests 缺失或为空均报错", () => {
    expectLoadError(VALID.replace(/^ {2}refs:.*\n/m, ""), /refs/);
    expectLoadError(VALID.replace(/^ {2}tests:\n( {4}.*\n)+/m, ""), /tests/);
  });

  describe("loadRules（目录级）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agentfence-rules-"));
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("目录不存在 / 无 yaml 文件均 fail-closed", () => {
      expect(() => loadRules(path.join(dir, "nope"))).toThrow(RuleLoadError);
      expect(() => loadRules(dir)).toThrow(/没有 \*\.yaml/);
    });

    it("跨文件重复 id 报错；合法目录按 priority 排序", () => {
      writeFileSync(path.join(dir, "a.yaml"), VALID);
      writeFileSync(path.join(dir, "b.yaml"), VALID);
      expect(() => loadRules(dir)).toThrow(/重复的规则 id/);

      writeFileSync(
        path.join(dir, "b.yaml"),
        VALID.replace("test.ok", "test.second").replace("priority: 1", "priority: 0"),
      );
      const rules = loadRules(dir);
      expect(rules.map((r) => r.id)).toEqual(["test.second", "test.ok"]);
      expect(rules[0]?.source_file).toBe("b.yaml");
    });
  });
});
