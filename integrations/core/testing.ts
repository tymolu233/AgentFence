/**
 * 测试专用装配：真实 createEngine + 仓库内置 rules/ 与 policies/default.yaml，
 * 审计落临时目录（不污染仓库）。判定层零 mock —— 测试断言的是
 * "真实 payload → 真实引擎 → 宿主响应" 的端到端行为。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Engine } from "../../src/engine/index.js";
import { engineFromConfig } from "./engine.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export interface TestEngineHandle {
  engine: Engine;
  /** 审计落盘目录（临时） */
  dir: string;
}

export function createTestEngine(): TestEngineHandle {
  const dir = mkdtempSync(path.join(tmpdir(), "agentfence-hook-test-"));
  const engine = engineFromConfig({
    rulesDir: path.join(REPO_ROOT, "rules"),
    policyFile: path.join(REPO_ROOT, "policies", "default.yaml"),
    auditPath: path.join(dir, "audit.jsonl"),
    auditMode: "best_effort",
    judgeEnabled: false,
  });
  return { engine, dir };
}
