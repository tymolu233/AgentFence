import { describe, expect, it } from "vitest";
import type { ParsedCommand, ToolCall } from "../api/types.js";
import type { Rule } from "./schema.js";
import {
  evaluateToolCall,
  isGuardedTarget,
  lexArgs,
  matchRuleAgainstCall,
  matchRuleAgainstCommand,
} from "./matcher.js";
import { sh, shellCall } from "./fixtures.js";

function cmd(executable: string, ...args: string[]): ParsedCommand {
  return { executable, args, redirects: {}, env: {}, indirect: false };
}

function makeRule(overrides: Partial<Rule>): Rule {
  return {
    id: "test.rule",
    category: "shell",
    severity: "low",
    action: "REVIEW",
    priority: 100,
    match: { argv0: ["true"] },
    refs: [],
    tests: { deny: [], allow: [] },
    source_file: "test.yaml",
    ...overrides,
  };
}

describe("lexArgs：flag 归一化", () => {
  it("组合短 flag 拆分 + 别名折叠", () => {
    const { flags } = lexArgs(["-rf"]);
    expect(flags.get("recursive")).toBe(true);
    expect(flags.get("f")).toBe(true);
  });

  it("长 flag、单横线长 flag（terraform 风格）、带值 flag", () => {
    expect(lexArgs(["--recursive"]).flags.get("recursive")).toBe(true);
    expect(lexArgs(["-auto-approve"]).flags.get("auto-approve")).toBe(true);
    expect(lexArgs(["--all=true"]).flags.get("all")).toBe("true");
    expect(lexArgs(["--shadow-database-url=$DATABASE_URL"]).flags.get("shadow-database-url")).toBe(
      "$database_url",
    );
  });

  it("-- 之后全部归位置参数", () => {
    const { flags, positionals } = lexArgs(["--", "-rf"]);
    expect(flags.size).toBe(0);
    expect(positionals).toEqual(["-rf"]);
  });
});

describe("matcher 原语", () => {
  it("argv0 归一化：basename + 去扩展名 + 小写", () => {
    const rule = makeRule({ match: { argv0: ["rm"] } });
    expect(matchRuleAgainstCommand(rule, cmd("/usr/bin/rm", "-rf", "/"))).toBe(true);
    expect(matchRuleAgainstCommand(rule, cmd("RM.EXE", "-rf", "/"))).toBe(true);
    expect(matchRuleAgainstCommand(rule, cmd("rmdir"))).toBe(false);
  });

  it("subcommand 序列支持 glob（delete-db-*）", () => {
    const rule = makeRule({
      match: { argv0: ["aws"], subcommand: ["rds", "delete-db-*"] },
    });
    expect(matchRuleAgainstCommand(rule, cmd("aws", "rds", "delete-db-instance", "prod"))).toBe(true);
    expect(matchRuleAgainstCommand(rule, cmd("aws", "rds", "describe-db-instances"))).toBe(false);
    expect(matchRuleAgainstCommand(rule, cmd("aws", "rds"))).toBe(false);
  });

  it("any 组合子取 OR", () => {
    const rule = makeRule({
      match: { any: [{ argv0: ["mongosh"] }, { argv0: ["mongo"] }] },
    });
    expect(matchRuleAgainstCommand(rule, cmd("mongo", "prod"))).toBe(true);
    expect(matchRuleAgainstCommand(rule, cmd("redis-cli"))).toBe(false);
  });

  it("flags 精确值匹配", () => {
    const rule = makeRule({ match: { argv0: ["tool"], flags: { mode: "json" } } });
    expect(matchRuleAgainstCommand(rule, cmd("tool", "--mode=json"))).toBe(true);
    expect(matchRuleAgainstCommand(rule, cmd("tool", "--mode=yaml"))).toBe(false);
  });

  it("target_guarded 语义谓词", () => {
    for (const guarded of ["/", "//", "/*", "~", "~/", ".", "./", "..", "$HOME", "${HOME}", "%USERPROFILE%"]) {
      expect(isGuardedTarget(guarded), guarded).toBe(true);
    }
    for (const free of ["./node_modules", "/tmp", "~/projects", "../src", "build/"]) {
      expect(isGuardedTarget(free), free).toBe(false);
    }
  });

  it("args_regex 对超长参数截断（ReDoS 防线）", () => {
    const rule = makeRule({ match: { argv0: ["mysql"], args_regex: ["/DROP DATABASE/"] } });
    const beyond = `${"x".repeat(5000)} DROP DATABASE`;
    expect(matchRuleAgainstCommand(rule, cmd("mysql", beyond))).toBe(false);
    expect(matchRuleAgainstCommand(rule, cmd("mysql", "DROP DATABASE shop"))).toBe(true);
  });
});

describe("字段路由", () => {
  it("match.tool 命中 tool.name 或 tool.category，不命中则规则不判", () => {
    const rule = makeRule({ match: { tool: "shell", argv0: ["rm"] } });
    const fsCall: ToolCall = {
      request_id: "req_1",
      agent_id: "vitest",
      tool: { name: "fs.write", action: "write", category: "filesystem" },
      input: { path: "/tmp/x" },
    };
    expect(matchRuleAgainstCall(rule, fsCall, sh("rm -rf /"))).toBeNull();
    expect(matchRuleAgainstCall(rule, shellCall("rm -rf /"), sh("rm -rf /"))).toBe(0);
  });

  it("纯 tool 路由规则无需 ParsedShell 即可命中", () => {
    const rule = makeRule({ match: { tool: "fs.write" } });
    const call: ToolCall = {
      request_id: "req_2",
      agent_id: "vitest",
      tool: { name: "fs.write", action: "write" },
      input: {},
    };
    expect(matchRuleAgainstCall(rule, call)).toBe(0);
  });

  it("命令类规则在 ParsedShell 缺失时不判（解析层自行 fail-closed）", () => {
    const rule = makeRule({ match: { argv0: ["rm"] } });
    expect(matchRuleAgainstCall(rule, shellCall("rm -rf /"))).toBeNull();
  });
});

describe("仲裁：显式 priority + deny-overrides", () => {
  const denyLow = makeRule({
    id: "test.deny-low",
    action: "DENY",
    severity: "medium",
    priority: 50,
    match: { argv0: ["rm"] },
  });
  const reviewHigh = makeRule({
    id: "test.review-high",
    action: "REVIEW",
    severity: "critical",
    priority: 10,
    match: { argv0: ["rm"] },
  });

  it("DENY > REVIEW，与 priority 无关；risk 取命中最高 severity", () => {
    const verdict = evaluateToolCall([denyLow, reviewHigh], shellCall("rm x"), sh("rm x"));
    expect(verdict?.decision).toBe("DENY");
    expect(verdict?.matched_rules[0]).toBe("test.deny-low");
    expect(verdict?.risk).toBe("CRITICAL");
    expect(verdict?.matched_rules).toHaveLength(2);
  });

  it("同 action 按 priority 升序", () => {
    const a = makeRule({ id: "test.a", action: "DENY", priority: 30, match: { argv0: ["rm"] } });
    const b = makeRule({ id: "test.b", action: "DENY", priority: 20, match: { argv0: ["rm"] } });
    const verdict = evaluateToolCall([a, b], shellCall("rm x"), sh("rm x"));
    expect(verdict?.matched_rules).toEqual(["test.b", "test.a"]);
  });

  it("无命中返回 undefined（无命中即 ALLOW 由上层装配）", () => {
    expect(evaluateToolCall([denyLow], shellCall("ls"), sh("ls"))).toBeUndefined();
  });

  it("多子命令：任一子命令命中即判，记录子命令序号", () => {
    const parsed = sh("cd /tmp && rm -rf /data");
    expect(matchRuleAgainstCall(denyLow, shellCall("cd /tmp && rm -rf /data"), parsed)).toBe(1);
    const verdict = evaluateToolCall([denyLow], shellCall("cd /tmp && rm -rf /data"), parsed);
    expect(verdict?.decision).toBe("DENY");
  });
});
