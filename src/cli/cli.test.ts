/**
 * CLI 端到端测试：真实子进程跑构建产物 dist/src/cli/index.js。
 * beforeAll 先跑 npm run build；配置用临时目录里的 agentfence.yaml
 * （rules/policy 指回仓库内置资产，审计落临时目录，不污染仓库）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Decision } from "../api/types.js";
import type { AuditRecord } from "../audit/index.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = path.join(REPO_ROOT, "dist", "src", "cli", "index.js");

const tmp = mkdtempSync(path.join(tmpdir(), "agentfence-cli-"));
const AUDIT_PATH = path.join(tmp, "audit.jsonl");
const CONFIG_PATH = path.join(tmp, "agentfence.yaml");

beforeAll(() => {
  // 等价于 npm run build；直调 tsc 避免 Windows 上 .cmd 需要 shell 的问题
  execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
    { cwd: REPO_ROOT, stdio: "pipe" },
  );
  // YAML 里写绝对路径，JSON.stringify 兼作 YAML 双引号标量转义
  writeFileSync(
    CONFIG_PATH,
    [
      `rules_dir: ${JSON.stringify(path.join(REPO_ROOT, "rules"))}`,
      `policy_file: ${JSON.stringify(path.join(REPO_ROOT, "policies", "default.yaml"))}`,
      "audit:",
      `  path: ${JSON.stringify(AUDIT_PATH)}`,
      "  mode: best_effort",
      "judge:",
      "  enabled: false",
      "",
    ].join("\n"),
    "utf8",
  );
}, 180_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: readonly string[]): RunResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: tmp,
    encoding: "utf8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function check(args: readonly string[]): RunResult {
  return run(["check", "--config", CONFIG_PATH, ...args]);
}

describe("agentfence check", () => {
  it("rm -rf / → DENY，退出码 1", () => {
    const result = check(["--tool", "shell", "--command", "rm -rf /"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("DENY");
    expect(result.stdout).toContain("fs.rm-recursive-guarded-path");
  });

  it("ls → ALLOW，退出码 0", () => {
    const result = check(["--tool", "shell", "--command", "ls"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ALLOW");
  });

  it("fdisk /dev/sda → REVIEW，退出码 2", () => {
    const result = check(["--tool", "shell", "--command", "fdisk /dev/sda"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("REVIEW");
  });

  it("--json 输出可解析的 Decision", () => {
    const result = check(["--tool", "shell", "--command", "rm -rf /", "--json"]);
    expect(result.status).toBe(1);
    const decision = JSON.parse(result.stdout) as Decision;
    expect(decision.decision).toBe("DENY");
    expect(decision.decision_layer).toBe("rules");
    expect(decision.matched_rules).toContain("fs.rm-recursive-guarded-path");
    expect(decision.policy_version).toBe("policy-v1");
  });

  it("解析失败的命令 → fail-closed DENY，退出码 1", () => {
    const result = check(["--tool", "shell", "--command", "ls '"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("DENY");
  });

  it("缺 --tool → 用法错误，退出码 64", () => {
    const result = check(["--command", "ls"]);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("--tool");
  });

  it("--config 指向不存在的文件 → fail-closed，退出码 1", () => {
    const result = run([
      "check",
      "--config",
      path.join(tmp, "nope.yaml"),
      "--tool",
      "shell",
      "--command",
      "ls",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fail-closed");
  });
});

describe("agentfence exec", () => {
  it("ALLOW → 执行并透传退出码 0", () => {
    const result = run(["exec", "--config", CONFIG_PATH, "--", "node", "--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/v\d+\.\d+\.\d+/);
  });

  it("ALLOW → 透传非零退出码", () => {
    // node -e "process.exit(7)" 的括号对 shell parser 是元字符，走 fixture 脚本
    const fixture = path.join(tmp, "exit7.js");
    writeFileSync(fixture, "process.exit(7);\n", "utf8");
    const result = run(["exec", "--config", CONFIG_PATH, "--", "node", fixture]);
    expect(result.status).toBe(7);
  });

  it("DENY → 不执行，退出码 1", () => {
    const result = run(["exec", "--config", CONFIG_PATH, "--", "rm", "-rf", "/"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("未执行");
  });

  it("REVIEW → 拒绝执行并提示审批，退出码 2", () => {
    const result = run([
      "exec",
      "--config",
      CONFIG_PATH,
      "--",
      "fdisk",
      "/dev/sda",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("审批");
  });

  it("缺 -- → 用法错误，退出码 64", () => {
    const result = run(["exec", "--config", CONFIG_PATH]);
    expect(result.status).toBe(64);
  });
});

describe("审计落盘", () => {
  it("check 的 ALLOW 与 DENY 都写入审计文件", () => {
    const records = readFileSync(AUDIT_PATH, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AuditRecord);
    const decisions = records.map((r) => r.decision);
    expect(decisions).toContain("ALLOW");
    expect(decisions).toContain("DENY");
    expect(decisions).toContain("REVIEW");
    for (const record of records) {
      expect(record.input_digest).toMatch(/^sha256:/);
      expect(record.judge_used).toBe(false);
    }
  });
});
