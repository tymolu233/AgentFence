import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { computeRecordHash } from "./canonical.js";
import { redactRecord } from "./redact.js";
import { GENESIS_HASH } from "./types.js";
import type { AuditRecord, AuditRecordInput } from "./types.js";

export type VerifyResult = { ok: true } | { ok: false; line: number };

/**
 * JSONL append-only 写入器。
 * 每行 hash = sha256(prev_hash + 规范化字段)，首行 prev_hash 为 "genesis"。
 * 打开已有文件时从末行恢复 prev_hash，链可跨进程续写。
 */
export class AuditLogWriter {
  private prevHash: string;

  constructor(private readonly filePath: string) {
    this.prevHash = readTailHash(filePath);
  }

  get lastHash(): string {
    return this.prevHash;
  }

  /** 脱敏 → 算链 → 追加一行。调用方（队列 drain）负责捕获异常。 */
  append(input: AuditRecordInput): AuditRecord {
    const redacted = redactRecord(input);
    const hash = computeRecordHash(this.prevHash, redacted);
    const record: AuditRecord = { ...redacted, prev_hash: this.prevHash, hash };
    appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf8");
    this.prevHash = hash;
    return record;
  }
}

function readTailHash(filePath: string): string {
  try {
    if (!existsSync(filePath)) return GENESIS_HASH;
    const lines = readFileSync(filePath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const last = lines[lines.length - 1];
    if (last === undefined) return GENESIS_HASH;
    const parsed = JSON.parse(last) as Partial<AuditRecord>;
    return typeof parsed.hash === "string" ? parsed.hash : GENESIS_HASH;
  } catch {
    return GENESIS_HASH;
  }
}

/** 重放校验整条哈希链；line 为 1 起始的行号，文件不可读时 line 为 0 */
export function verifyChain(filePath: string): VerifyResult {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return { ok: false, line: 0 };
  }
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  let prev = GENESIS_HASH;
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    if (raw === undefined) return { ok: false, line: lineNo };
    let record: AuditRecord;
    try {
      record = JSON.parse(raw) as AuditRecord;
    } catch {
      return { ok: false, line: lineNo };
    }
    if (record.prev_hash !== prev) return { ok: false, line: lineNo };
    const fields: AuditRecordInput = {
      timestamp: record.timestamp,
      request_id: record.request_id,
      agent_id: record.agent_id,
      tool: record.tool,
      decision: record.decision,
      risk: record.risk,
      decision_layer: record.decision_layer,
      matched_rules: record.matched_rules,
      judge_used: record.judge_used,
      input_digest: record.input_digest,
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
      ...(record.policy_version !== undefined
        ? { policy_version: record.policy_version }
        : {}),
      ...(record.latency_ms !== undefined ? { latency_ms: record.latency_ms } : {}),
    };
    if (typeof record.hash !== "string" || computeRecordHash(prev, fields) !== record.hash) {
      return { ok: false, line: lineNo };
    }
    prev = record.hash;
  }
  return { ok: true };
}
