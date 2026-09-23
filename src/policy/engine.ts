/**
 * Policy 引擎：进程内纯函数判定管线。
 * 判定顺序固定（DeepintShield decide.go 骨架）：
 *   1. cheapest-deny-first 短路（allow-list / 规则层 DENY 透传 / 环境表拒绝短路）
 *   2. 策略求值（结构化规则 → 环境表 ALLOW 兜底）
 *   3. fail-closed（策略缺失且工具高危 → DENY）
 *   4. autonomy budget 降级（ALLOW → REVIEW，只降级不升级）
 *   5. enforcement mode（shadow 只标 would_block，不产出 DENY/REVIEW）
 */
import type { PolicyEvaluator } from "./evaluator.js";
import {
  StructuredEvaluator,
  applyAutonomyBudget,
  evaluateEnvironmentPolicy,
} from "./evaluator.js";
import type { PolicyConfig, PolicyInput, PolicyVerdict } from "./types.js";
import { HIGH_RISK_THRESHOLD, riskAtLeast } from "./types.js";

export interface PolicyEngine {
  decide(input: PolicyInput): PolicyVerdict | null;
}

export function createPolicyEngine(
  config: PolicyConfig,
  evaluator: PolicyEvaluator = new StructuredEvaluator(),
): PolicyEngine {
  return {
    decide(input: PolicyInput): PolicyVerdict | null {
      // 1a. allow-list 短路：配置了白名单且工具不在其中 → DENY
      if (
        config.allowed_tools !== undefined &&
        !config.allowed_tools.includes(input.call.tool.name)
      ) {
        return finalize(
          {
            verdict: "DENY",
            reason: `tool ${input.call.tool.name} not in allow-list`,
            policy_id: "policy.allow_list",
          },
          input,
          config,
        );
      }

      // 1b. 规则层已 DENY → 透传（deny-overrides，策略无权解除）
      if (input.rules?.verdict === "DENY") {
        const matched = input.rules.matched_rules?.[0];
        return finalize(
          {
            verdict: "DENY",
            reason: `rules layer denied${matched !== undefined ? `: ${matched}` : ""}`,
            policy_id: "rules.passthrough",
          },
          input,
          config,
        );
      }

      // 1c. 环境表拒绝短路（cheapest-deny-first）：环境策略给出 DENY/REVIEW 即落定
      const envVerdict = evaluateEnvironmentPolicy(input, config.policy, "policy");
      if (envVerdict !== null && envVerdict.verdict !== "ALLOW") {
        return finalize(envVerdict, input, config);
      }

      // 2. 结构化规则求值（priority 升序，首个命中胜出）；无命中则环境表 ALLOW 兜底
      const verdict =
        evaluator.evaluate(input, config.rules) ?? envVerdict;

      // 3. fail-closed：策略无意见且工具高危 → DENY
      if (verdict === null) {
        if (
          config.mode === "fail_closed" &&
          input.rules?.risk !== undefined &&
          riskAtLeast(input.rules.risk, HIGH_RISK_THRESHOLD)
        ) {
          return finalize(
            {
              verdict: "DENY",
              reason: `fail-closed: no policy opinion for high-risk tool (risk ${input.rules.risk})`,
              policy_id: "policy.fail_closed",
            },
            input,
            config,
          );
        }
        return null;
      }

      return finalize(verdict, input, config);
    },
  };
}

/** 4+5. autonomy budget 降级，然后按 enforcement mode 收尾 */
function finalize(
  verdict: PolicyVerdict,
  input: PolicyInput,
  config: PolicyConfig,
): PolicyVerdict {
  const budgeted = applyAutonomyBudget(
    verdict,
    input.rules?.risk,
    config.autonomy_budget,
  );
  if (config.enforcement === "shadow" && budgeted.verdict !== "ALLOW") {
    return {
      verdict: "ALLOW",
      reason: `shadow: would ${budgeted.verdict.toLowerCase()} — ${budgeted.reason}`,
      policy_id: budgeted.policy_id,
      would_block: true,
    };
  }
  return budgeted;
}
