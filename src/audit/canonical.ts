import { createHash } from "node:crypto";
import type { AuditRecordInput } from "./types.js";

/** 键排序后的稳定 JSON 序列化，保证哈希输入与键序无关 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  return (
    "{" +
    keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(obj[key])).join(",") +
    "}"
  );
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** 工具输入只落摘要：sha256(canonical JSON) */
export function computeInputDigest(input: Record<string, unknown>): string {
  return "sha256:" + sha256Hex(canonicalJson(input));
}

/** 链式哈希：sha256(prev_hash + 规范化字段)，与 verifyChain 重放口径一致 */
export function computeRecordHash(prevHash: string, record: AuditRecordInput): string {
  return sha256Hex(prevHash + "\n" + canonicalJson(record));
}
