/**
 * SessionStore：Judge 的 user_requested / from_untrusted 信号的会话上下文
 * 数据源（任务 D4，对齐 docs/research/jev-guard.md 与 .agents/notes/
 * implemented/architecture/2026-09-23-tool-call-decision-model.md 不变量 3/4）。
 *
 * 每个 session_id 一个 JSON 文件：<dir>/<sha1(session_id) 前 16 位>.json，
 * 文件 0600、目录 0700；写盘走临时文件 + rename 原子替换，hook 进程被宿主
 * 强杀（~30s 硬超时）也不会留下截断的半个文件。超 7 天的会话文件在 load 时
 * 按 mtime 惰性删除。
 *
 * 容量封顶（环形：超限丢最旧；对齐 jev-guard src/session.js:10）：
 *   user_messages ≤ 6 条（每条截 700 字符）
 *   tool_calls    ≤ 12 条（网关侧回写的 tool + decision + 输入摘录）
 *   flags         ≤ 10 条（kind + excerpt + p）
 *
 * snapshot() 产出判定输入（进 ToolCall.session，见 src/api/types.ts
 * SessionContext 注释）：user_intent 取最近 3 条用户消息 "\n" 连接、
 * recent_tool_calls 最近 6 条、flagged_untrusted 最近 5 条。
 *
 * 不变量 3：会话状态由网关侧维护——engine 在判定前注入 snapshot、判定落定后
 * 回写 decision；只收录用户本人消息（UserPromptSubmit），agent 自述意图与
 * tool result 一律不进 user_messages（不变量 4 及其亲属条款）。
 *
 * 并发模型：全部方法是同步 fs 调用，单进程内天然串行（无需锁）；hook 冷启动
 * 进程模型下跨进程的一致性靠单文件原子替换与只追加语义，崩溃最坏代价是丢
 * 最后一次 append。
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { DecisionKind, FlaggedUntrusted, SessionContext } from "../api/types.js";

/** 容量与截断上限（测试同样引用，勿各自硬编码） */
export const SESSION_LIMITS = {
  userMessagesCap: 6,
  userMessageMaxChars: 700,
  toolCallsCap: 12,
  inputExcerptMaxChars: 80,
  flagsCap: 10,
  flagExcerptMaxChars: 300,
  flagKindMaxChars: 100,
  snapshotUserMessages: 3,
  snapshotToolCalls: 6,
  snapshotFlags: 5,
} as const;

/** 会话文件惰性清理阈值：7 天 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SESSION_ID_MAX_CHARS = 512;
const FILE_VERSION = 1;
const DECISION_KINDS: readonly DecisionKind[] = ["ALLOW", "REVIEW", "DENY"];

export class SessionStoreError extends Error {
  override readonly name = "SessionStoreError";
}

/** 网关侧回写的一次工具调用记录（"它做过什么 + 结果如何"） */
export interface ToolCallNote {
  /** `${tool.name} ${tool.action}`，如 "shell execute" */
  tool: string;
  decision: DecisionKind;
  /** 命令 / 文件路径 / URL 等可读提示（截 80 字符）；无则缺省 */
  input_excerpt?: string;
}

/** 一份会话的状态（按时间旧 → 新；也是 load 的返回形状） */
export interface SessionData {
  user_messages: string[];
  tool_calls: ToolCallNote[];
  flags: FlaggedUntrusted[];
  /** 最近一次写入时刻（ISO） */
  updated_at: string;
}

export interface SessionStoreOptions {
  /** 会话文件目录；装配方默认给 <audit 同级目录>/sessions */
  dir: string;
}

interface SessionFile extends SessionData {
  version: number;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function requireSessionId(id: string): string {
  if (typeof id !== "string" || id.trim() === "" || id.length > SESSION_ID_MAX_CHARS) {
    throw new SessionStoreError("session_id 必须是 1–512 字符的非空字符串");
  }
  return id;
}

/** 文件名只取 sha1 前 16 位：宿主传来的任意字符都不会变成路径 */
function fileNameFor(id: string): string {
  return `${createHash("sha1").update(id, "utf8").digest("hex").slice(0, 16)}.json`;
}

function emptyData(): SessionData {
  return { user_messages: [], tool_calls: [], flags: [], updated_at: new Date(0).toISOString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeStrings(value: unknown, maxChars: number, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") out.push(truncate(item, maxChars));
  }
  return out.slice(-cap);
}

function sanitizeToolCalls(value: unknown): ToolCallNote[] {
  if (!Array.isArray(value)) return [];
  const out: ToolCallNote[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.tool !== "string" || item.tool === "") continue;
    if (typeof item.decision !== "string" || !DECISION_KINDS.includes(item.decision as DecisionKind)) {
      continue;
    }
    const note: ToolCallNote = { tool: item.tool, decision: item.decision as DecisionKind };
    if (typeof item.input_excerpt === "string") {
      note.input_excerpt = truncate(item.input_excerpt, SESSION_LIMITS.inputExcerptMaxChars);
    }
    out.push(note);
  }
  return out.slice(-SESSION_LIMITS.toolCallsCap);
}

function sanitizeFlags(value: unknown): FlaggedUntrusted[] {
  if (!Array.isArray(value)) return [];
  const out: FlaggedUntrusted[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.kind !== "string" || item.kind === "") continue;
    if (typeof item.excerpt !== "string") continue;
    if (typeof item.p !== "number" || !Number.isFinite(item.p)) continue;
    out.push({
      kind: truncate(item.kind, SESSION_LIMITS.flagKindMaxChars),
      excerpt: truncate(item.excerpt, SESSION_LIMITS.flagExcerptMaxChars),
      p: Math.min(Math.max(item.p, 0), 1),
    });
  }
  return out.slice(-SESSION_LIMITS.flagsCap);
}

function formatToolCallNote(note: ToolCallNote): string {
  return note.input_excerpt !== undefined
    ? `${note.tool} → ${note.decision}（${note.input_excerpt}）`
    : `${note.tool} → ${note.decision}`;
}

export class SessionStore {
  readonly #dir: string;

  constructor(options: SessionStoreOptions) {
    this.#dir = options.dir;
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
  }

  /** 会话文件目录（测试与排查用） */
  get dir(): string {
    return this.#dir;
  }

  /**
   * 读取会话状态。非法 session_id 抛 SessionStoreError；文件不存在 /
   * JSON 损坏 / 字段畸形一律按空会话处理（下次 append 覆盖）；超 7 天的
   * 文件顺手删除（惰性清理）。
   */
  load(id: string): SessionData {
    // 校验必须在 try 之外：非法 id 是调用契约错误（fail-early），
    // 不能被"文件不存在 → 空会话"的降级吃掉
    const file = this.fileFor(id);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      return emptyData();
    }
    if (Date.now() - mtimeMs > SESSION_TTL_MS) {
      try {
        unlinkSync(file);
      } catch {
        /* 删除失败不阻塞读取，同样按空会话 */
      }
      return emptyData();
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isRecord(parsed)) return emptyData();
      return {
        user_messages: sanitizeStrings(
          parsed.user_messages,
          SESSION_LIMITS.userMessageMaxChars,
          SESSION_LIMITS.userMessagesCap,
        ),
        tool_calls: sanitizeToolCalls(parsed.tool_calls),
        flags: sanitizeFlags(parsed.flags),
        updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : new Date(0).toISOString(),
      };
    } catch {
      return emptyData();
    }
  }

  /** 记录一条用户本人消息（≤700 字符；环形上限 6 条）。text 空串/非串抛错 */
  appendUserMessage(id: string, text: string): void {
    if (typeof text !== "string" || text === "") {
      throw new SessionStoreError("appendUserMessage 的 text 必须是非空字符串");
    }
    this.mutate(id, (data) => {
      data.user_messages.push(truncate(text, SESSION_LIMITS.userMessageMaxChars));
      data.user_messages = data.user_messages.slice(-SESSION_LIMITS.userMessagesCap);
    });
  }

  /** 回写一次工具调用及其判定（环形上限 12 条）。形状非法抛错 */
  appendToolCall(id: string, note: ToolCallNote): void {
    if (typeof note.tool !== "string" || note.tool === "") {
      throw new SessionStoreError("ToolCallNote.tool 必须是非空字符串");
    }
    if (!DECISION_KINDS.includes(note.decision)) {
      throw new SessionStoreError(`ToolCallNote.decision 非法：${String(note.decision)}`);
    }
    this.mutate(id, (data) => {
      const entry: ToolCallNote = { tool: note.tool, decision: note.decision };
      if (note.input_excerpt !== undefined) {
        entry.input_excerpt = truncate(note.input_excerpt, SESSION_LIMITS.inputExcerptMaxChars);
      }
      data.tool_calls.push(entry);
      data.tool_calls = data.tool_calls.slice(-SESSION_LIMITS.toolCallsCap);
    });
  }

  /** 记录一条不可信内容命中（环形上限 10 条）。p 必须是 [0,1] 校准概率 */
  appendFlag(id: string, flag: FlaggedUntrusted): void {
    if (typeof flag.kind !== "string" || flag.kind === "") {
      throw new SessionStoreError("FlaggedUntrusted.kind 必须是非空字符串");
    }
    if (typeof flag.excerpt !== "string") {
      throw new SessionStoreError("FlaggedUntrusted.excerpt 必须是字符串");
    }
    if (typeof flag.p !== "number" || !Number.isFinite(flag.p) || flag.p < 0 || flag.p > 1) {
      throw new SessionStoreError("FlaggedUntrusted.p 必须是 [0,1] 内的校准概率");
    }
    this.mutate(id, (data) => {
      data.flags.push({
        kind: truncate(flag.kind, SESSION_LIMITS.flagKindMaxChars),
        excerpt: truncate(flag.excerpt, SESSION_LIMITS.flagExcerptMaxChars),
        p: flag.p,
      });
      data.flags = data.flags.slice(-SESSION_LIMITS.flagsCap);
    });
  }

  /**
   * 判定输入快照：user_intent 为最近 ≤3 条用户消息 "\n" 连接、
   * recent_tool_calls 最近 ≤6 条（"tool action → DECISION（摘录）"）、
   * flagged_untrusted 最近 ≤5 条；三类皆空时返回全缺省对象。
   */
  snapshot(id: string): SessionContext {
    const data = this.load(id);
    const ctx: SessionContext = {};
    const messages = data.user_messages.slice(-SESSION_LIMITS.snapshotUserMessages);
    if (messages.length > 0) ctx.user_intent = messages.join("\n");
    const calls = data.tool_calls.slice(-SESSION_LIMITS.snapshotToolCalls).map(formatToolCallNote);
    if (calls.length > 0) ctx.recent_tool_calls = calls;
    const flags = data.flags.slice(-SESSION_LIMITS.snapshotFlags);
    if (flags.length > 0) ctx.flagged_untrusted = flags;
    return ctx;
  }

  /** session_id → 文件路径（id 校验在这里统一收口；sha1 命名杜绝路径注入） */
  private fileFor(id: string): string {
    return path.join(this.#dir, fileNameFor(requireSessionId(id)));
  }

  private mutate(id: string, fn: (data: SessionData) => void): void {
    const data = this.load(id);
    fn(data);
    this.persist(id, data);
  }

  /** tmp 文件 + rename 原子替换；0600 新建即带，chmod 兜底既有文件 */
  private persist(id: string, data: SessionData): void {
    const file = this.fileFor(id);
    const tmp = `${file}.${String(process.pid)}.tmp`;
    const body: SessionFile = {
      version: FILE_VERSION,
      updated_at: new Date().toISOString(),
      user_messages: data.user_messages,
      tool_calls: data.tool_calls,
      flags: data.flags,
    };
    writeFileSync(tmp, `${JSON.stringify(body)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* 无 mode 语义的平台（Windows）best effort */
    }
  }
}
