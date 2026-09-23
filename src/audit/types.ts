import type { DecisionKind, DecisionLayer, RiskLevel } from "../api/types.js";

/** 哈希链首行的 prev_hash 哨兵值 */
export const GENESIS_HASH = "genesis";

/**
 * 落盘前的审计记录（不含链字段）。
 * 永不携带 input 原文，只携带 input_digest。
 */
export interface AuditRecordInput {
  /** ISO 8601 时间戳 */
  timestamp: string;
  request_id: string;
  agent_id: string;
  tool: string;
  decision: DecisionKind;
  risk: RiskLevel;
  decision_layer: DecisionLayer;
  matched_rules: string[];
  /** 判定是否经过 judge 层 */
  judge_used: boolean;
  /** 工具输入的 sha256 摘要（"sha256:<hex>"），不落原文 */
  input_digest: string;
  /** 判定理由；落盘前做密钥脱敏 */
  reason?: string;
  policy_version?: string;
  latency_ms?: number;
}

/** 落盘的审计记录：输入字段 + 哈希链字段 */
export interface AuditRecord extends AuditRecordInput {
  prev_hash: string;
  hash: string;
}

/** 队列满时的三档背压策略 */
export type BackpressureMode = "best_effort" | "durable" | "fail_closed";

/**
 * record() 的返回信号。永不抛异常。
 * fail_closed 模式下队列满返回 { queued: false }，由调用方把非 DENY 改写为 DENY。
 */
export type RecordResult =
  | { queued: true }
  | { queued: false; code: "QUEUE_FULL" | "CLOSED" };

export interface AuditStats {
  received: number;
  written: number;
  /** best_effort 模式下因队列满丢弃的条数 */
  dropped: number;
  /** durable 模式下溢写磁盘的条数 */
  spilled: number;
  /** durable 模式下从 spill 文件重放回来的条数 */
  replayed: number;
  writeErrors: number;
}
