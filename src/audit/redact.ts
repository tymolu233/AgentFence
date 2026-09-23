import type { AuditRecordInput } from "./types.js";

const SECRET_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  {
    kind: "private_key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  { kind: "github_pat", pattern: /github_pat_[A-Za-z0-9_]{22,}/g },
  { kind: "github_token", pattern: /\bghp_[A-Za-z0-9]{36,}/g },
  { kind: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
];

/** 常见 token 形状脱敏：ghp_、github_pat_、AWS AKIA、私钥块 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { kind, pattern } of SECRET_PATTERNS) {
    out = out.replace(pattern, `[REDACTED:${kind}]`);
  }
  return out;
}

/** 落盘前对记录的全部文本类字段做脱敏 */
export function redactRecord(record: AuditRecordInput): AuditRecordInput {
  return {
    ...record,
    request_id: redactSecrets(record.request_id),
    agent_id: redactSecrets(record.agent_id),
    tool: redactSecrets(record.tool),
    matched_rules: record.matched_rules.map((rule) => redactSecrets(rule)),
    input_digest: redactSecrets(record.input_digest),
    ...(record.reason !== undefined ? { reason: redactSecrets(record.reason) } : {}),
    ...(record.policy_version !== undefined
      ? { policy_version: redactSecrets(record.policy_version) }
      : {}),
  };
}
