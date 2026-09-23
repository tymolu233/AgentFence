import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import type { Decision } from "../api/types.js";
import type { AuditLogWriter } from "./writer.js";
import type {
  AuditRecordInput,
  AuditStats,
  BackpressureMode,
  RecordResult,
} from "./types.js";

export interface AuditQueueOptions {
  writer: AuditLogWriter;
  mode?: BackpressureMode;
  /** 有界内存队列容量，默认 4096 */
  capacity?: number;
  /** durable 模式的溢写文件路径 */
  spillPath?: string;
}

const DEFAULT_CAPACITY = 4096;

/**
 * 异步审计队列：有界内存队列 + setImmediate 后台 drain，审计出热路径。
 * record() 永不阻塞调用方、永不抛异常。
 */
export class AuditQueue {
  private readonly writer: AuditLogWriter;
  private readonly mode: BackpressureMode;
  private readonly capacity: number;
  private readonly spillPath: string | undefined;
  private buffer: AuditRecordInput[] = [];
  private scheduled = false;
  private closed = false;
  private drainDone: Promise<void> = Promise.resolve();
  private resolveDrain: (() => void) | undefined;
  private readonly counters: AuditStats = {
    received: 0,
    written: 0,
    dropped: 0,
    spilled: 0,
    replayed: 0,
    writeErrors: 0,
  };

  constructor(options: AuditQueueOptions) {
    this.writer = options.writer;
    this.mode = options.mode ?? "best_effort";
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.spillPath = options.spillPath;
  }

  record(input: AuditRecordInput): RecordResult {
    this.counters.received++;
    try {
      if (this.closed) return { queued: false, code: "CLOSED" };
      if (this.buffer.length < this.capacity) {
        this.buffer.push(input);
        this.schedule();
        return { queued: true };
      }
      switch (this.mode) {
        case "best_effort":
          this.counters.dropped++;
          return { queued: true };
        case "durable":
          this.spill(input, true);
          return { queued: true };
        case "fail_closed":
          return { queued: false, code: "QUEUE_FULL" };
      }
    } catch {
      return { queued: true };
    }
  }

  stats(): AuditStats {
    return { ...this.counters };
  }

  get size(): number {
    return this.buffer.length;
  }

  /** 等待已排期的 drain 完成 */
  async flush(): Promise<void> {
    await this.drainDone;
  }

  /** 停止接收新记录并落盘全部积压（含 spill 重放，可能需多轮） */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    for (let i = 0; i < 100; i++) {
      const spillLeft =
        this.mode === "durable" &&
        this.spillPath !== undefined &&
        existsSync(this.spillPath);
      if (this.buffer.length === 0 && !spillLeft) return;
      this.drain();
    }
  }

  private schedule(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    this.drainDone = new Promise<void>((resolve) => {
      this.resolveDrain = resolve;
    });
    setImmediate(() => {
      this.drain();
    });
  }

  private drain(): void {
    this.scheduled = false;
    // 先排空内存队列（较旧），再重放 spill（较新），保持落盘顺序
    this.drainBuffer();
    this.replaySpill();
    this.drainBuffer();
    this.resolveDrain?.();
    this.resolveDrain = undefined;
  }

  private drainBuffer(): void {
    let next = this.buffer.shift();
    while (next !== undefined) {
      try {
        this.writer.append(next);
        this.counters.written++;
      } catch {
        this.counters.writeErrors++;
      }
      next = this.buffer.shift();
    }
  }

  private spill(input: AuditRecordInput, countAsSpill: boolean): void {
    if (this.spillPath === undefined) {
      this.counters.dropped++;
      return;
    }
    try {
      appendFileSync(this.spillPath, JSON.stringify(input) + "\n", "utf8");
      if (countAsSpill) this.counters.spilled++;
    } catch {
      this.counters.writeErrors++;
    }
  }

  /** durable：内存队列排空后把 spill 文件读回（覆盖进程重启恢复场景） */
  private replaySpill(): void {
    if (this.mode !== "durable" || this.spillPath === undefined) return;
    let content: string;
    try {
      if (!existsSync(this.spillPath)) return;
      content = readFileSync(this.spillPath, "utf8");
      unlinkSync(this.spillPath);
    } catch {
      this.counters.writeErrors++;
      return;
    }
    for (const line of content.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const input = JSON.parse(line) as AuditRecordInput;
        if (this.buffer.length < this.capacity) {
          this.buffer.push(input);
          this.counters.replayed++;
        } else {
          // 容量不足则保留在 spill 中，不重复计 spilled
          this.spill(input, false);
        }
      } catch {
        this.counters.writeErrors++;
      }
    }
  }
}

/**
 * fail_closed 语义落实：审计无法保证时，由调用方把非 DENY 改写为 DENY。
 */
export function applyAuditBackpressure(decision: Decision, result: RecordResult): Decision {
  if (result.queued || decision.decision === "DENY") return decision;
  return {
    ...decision,
    decision: "DENY",
    reason: `audit fail-closed (${result.code}); original decision: ${decision.decision}`,
  };
}
