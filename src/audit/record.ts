import type { Decision, ToolCall } from "../api/types.js";
import { computeInputDigest } from "./canonical.js";
import type { AuditRecordInput } from "./types.js";

export interface BuildAuditRecordOptions {
  /** 判定是否经过 judge 层 */
  judge_used: boolean;
  timestamp?: string;
}

/**
 * 从统一契约构造审计记录。只取 input_digest（缺失时现算），不携带 input 原文。
 */
export function buildAuditRecord(
  call: ToolCall,
  decision: Decision,
  options: BuildAuditRecordOptions,
): AuditRecordInput {
  return {
    timestamp: options.timestamp ?? new Date().toISOString(),
    request_id: call.request_id,
    agent_id: call.agent_id,
    tool: call.tool.name,
    decision: decision.decision,
    risk: decision.risk,
    decision_layer: decision.decision_layer,
    matched_rules: [...decision.matched_rules],
    judge_used: options.judge_used,
    input_digest: call.input_digest ?? computeInputDigest(call.input),
    reason: decision.reason,
    ...(decision.policy_version !== undefined
      ? { policy_version: decision.policy_version }
      : {}),
    ...(decision.latency_ms !== undefined ? { latency_ms: decision.latency_ms } : {}),
  };
}
