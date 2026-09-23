/**
 * hook 进程的 engine 装配：与 src/cli/main.ts buildEngine 同一套接线
 * （rules → policy → audit queue → createEngine），配置走 loadCliConfig。
 *
 * 配置解析：环境变量 AGENTFENCE_CONFIG 指定 agentfence.yaml；
 * 缺省读 cwd 下 agentfence.yaml，再没有则用仓库内置默认
 * （rules/ + policies/default.yaml，审计写 cwd/.agentfence/audit.jsonl）。
 * hook 进程的 cwd 由宿主设定，一般为被打开的项目根。
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { AuditLogWriter, AuditQueue } from "../../src/audit/index.js";
import { loadCliConfig, type CliConfig } from "../../src/cli/config.js";
import { createEngine, type Engine } from "../../src/engine/index.js";
import { createPolicyEngine, loadPolicyFile } from "../../src/policy/index.js";
import { loadRules } from "../../src/rules/loader.js";

export function engineFromConfig(config: CliConfig): Engine {
  const rules = loadRules(config.rulesDir);
  const policyConfig = loadPolicyFile(config.policyFile);
  const policy = createPolicyEngine(policyConfig);
  mkdirSync(path.dirname(config.auditPath), { recursive: true });
  const audit = new AuditQueue({
    writer: new AuditLogWriter(config.auditPath),
    mode: config.auditMode,
    spillPath: `${config.auditPath}.spill`,
  });
  return createEngine({
    rules,
    policy,
    policyVersion: `policy-v${String(policyConfig.version)}`,
    ...(config.acl !== undefined ? { acl: config.acl } : {}),
    judge: { enabled: config.judgeEnabled },
    audit,
  });
}

/** 加载失败（配置/规则/策略非法）会抛错 —— 上层按 fail-closed 回 DENY */
export function createHookEngine(configPath = process.env.AGENTFENCE_CONFIG): Engine {
  return engineFromConfig(loadCliConfig(configPath));
}
