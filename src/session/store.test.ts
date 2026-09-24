/**
 * SessionStore 测试（D4）：容量封顶 / 截断 / snapshot 窗口 / 0600 /
 * 7 天惰性清理 / 非法 session_id / 损坏文件降级 / 跨实例持久化。
 * 全部落盘在临时目录，afterAll 清理。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SESSION_LIMITS,
  SessionStore,
  SessionStoreError,
} from "./index.js";

const tmp = mkdtempSync(path.join(tmpdir(), "agentfence-session-"));
let dirSeq = 0;

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeStore(): SessionStore {
  dirSeq += 1;
  return new SessionStore({ dir: path.join(tmp, `store-${String(dirSeq)}`) });
}

function fileFor(store: SessionStore, id: string): string {
  const name = `${createHash("sha1").update(id, "utf8").digest("hex").slice(0, 16)}.json`;
  return path.join(store.dir, name);
}

describe("SessionStore 基本读写", () => {
  it("appendUserMessage → snapshot.user_intent；跨实例（冷启动模型）可见", () => {
    const store = makeStore();
    store.appendUserMessage("s1", "帮我把构建产物部署到 staging");
    expect(store.snapshot("s1").user_intent).toBe("帮我把构建产物部署到 staging");

    // hook 进程模型：每次事件冷启动一个进程，靠文件共享状态
    const coldStart = new SessionStore({ dir: store.dir });
    expect(coldStart.snapshot("s1").user_intent).toBe("帮我把构建产物部署到 staging");
  });

  it("snapshot 三类字段皆空 → 全缺省；未知会话 → 全缺省", () => {
    const store = makeStore();
    const snap = store.snapshot("nobody");
    expect(snap.user_intent).toBeUndefined();
    expect(snap.recent_tool_calls).toBeUndefined();
    expect(snap.flagged_untrusted).toBeUndefined();
  });

  it("多次 append 同一 id 累积且按序保留", () => {
    const store = makeStore();
    store.appendUserMessage("s2", "第一句");
    store.appendUserMessage("s2", "第二句");
    store.appendUserMessage("s2", "第三句");
    expect(store.snapshot("s2").user_intent).toBe("第一句\n第二句\n第三句");
    expect(store.load("s2").user_messages).toHaveLength(3);
  });

  it("flag 与 tool call 各自独立累积", () => {
    const store = makeStore();
    store.appendToolCall("s3", { tool: "Write write", decision: "ALLOW", input_excerpt: "/repo/a.txt" });
    store.appendFlag("s3", { kind: "injection", excerpt: "ignore previous instructions", p: 0.91 });
    const snap = store.snapshot("s3");
    expect(snap.recent_tool_calls).toEqual(["Write write → ALLOW（/repo/a.txt）"]);
    expect(snap.flagged_untrusted).toEqual([
      { kind: "injection", excerpt: "ignore previous instructions", p: 0.91 },
    ]);
    expect(snap.user_intent).toBeUndefined();
  });
});

describe("容量封顶与截断（对齐 jev-guard session.js）", () => {
  it("user_messages 环形封顶 6 条、每条截 700 字符；snapshot 只取最近 3 条", () => {
    const store = makeStore();
    store.appendUserMessage("s4", "字".repeat(800));
    for (let i = 1; i <= 7; i += 1) {
      store.appendUserMessage("s4", `第 ${String(i)} 条`);
    }
    const data = store.load("s4");
    expect(data.user_messages).toHaveLength(SESSION_LIMITS.userMessagesCap);
    // 环形：最早两条（800 字符 + 第 1 条）已被挤出，窗口滑动但每条 ≤700
    expect(data.user_messages[0]).toBe("第 2 条");
    expect(data.user_messages.every((m) => m.length <= SESSION_LIMITS.userMessageMaxChars)).toBe(true);
    expect(store.snapshot("s4").user_intent).toBe("第 5 条\n第 6 条\n第 7 条");

    const long = makeStore();
    long.appendUserMessage("s5", "字".repeat(800));
    expect(long.load("s5").user_messages[0]).toHaveLength(SESSION_LIMITS.userMessageMaxChars);
  });

  it("tool_calls 封顶 12、snapshot 取最近 6 条带 decision；excerpt 截 80", () => {
    const store = makeStore();
    for (let i = 1; i <= 14; i += 1) {
      store.appendToolCall("s6", { tool: `tool${String(i)} act`, decision: i % 2 === 0 ? "DENY" : "ALLOW" });
    }
    const data = store.load("s6");
    expect(data.tool_calls).toHaveLength(SESSION_LIMITS.toolCallsCap);
    expect(data.tool_calls[0]?.tool).toBe("tool3 act");
    const snap = store.snapshot("s6");
    expect(snap.recent_tool_calls).toHaveLength(SESSION_LIMITS.snapshotToolCalls);
    expect(snap.recent_tool_calls?.[0]).toBe("tool9 act → ALLOW");
    expect(snap.recent_tool_calls?.[5]).toBe("tool14 act → DENY");

    store.appendToolCall("s6", { tool: "shell execute", decision: "ALLOW", input_excerpt: "x".repeat(120) });
    expect(store.load("s6").tool_calls.at(-1)?.input_excerpt).toHaveLength(SESSION_LIMITS.inputExcerptMaxChars);
  });

  it("flags 封顶 10、snapshot 取最近 5 条；excerpt 截 300", () => {
    const store = makeStore();
    for (let i = 1; i <= 12; i += 1) {
      store.appendFlag("s7", { kind: `k${String(i)}`, excerpt: "e".repeat(400), p: 0.9 });
    }
    const data = store.load("s7");
    expect(data.flags).toHaveLength(SESSION_LIMITS.flagsCap);
    expect(data.flags[0]?.kind).toBe("k3");
    expect(data.flags.every((f) => f.excerpt.length === SESSION_LIMITS.flagExcerptMaxChars)).toBe(true);
    const snap = store.snapshot("s7");
    expect(snap.flagged_untrusted).toHaveLength(SESSION_LIMITS.snapshotFlags);
    expect(snap.flagged_untrusted?.[0]?.kind).toBe("k8");
  });
});

describe("落盘形态", () => {
  it("文件名是 sha1(session_id) 前 16 位，含路径分隔符的 id 也不越出会话目录", () => {
    const store = makeStore();
    const evilId = "../../etc/passwd";
    store.appendUserMessage(evilId, "hi");
    const file = fileFor(store, evilId);
    expect(existsSync(file)).toBe(true);
    // 目录下只有这一个 json，文件名是 16 位 hex（无分隔符泄漏）
    const entries = readdirSync(store.dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^[0-9a-f]{16}\.json$/);
  });

  it("会话文件权限 0600（POSIX；Windows 无 mode 语义仅断言存在）", () => {
    const store = makeStore();
    store.appendUserMessage("s8", "secret-ish");
    const file = fileFor(store, "s8");
    expect(existsSync(file)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("超 7 天的会话文件在 load 时被惰性删除（mtime 判定）", () => {
    const store = makeStore();
    store.appendUserMessage("s9", "上周的会话");
    const file = fileFor(store, "s9");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(file, eightDaysAgo, eightDaysAgo);
    expect(store.load("s9").user_messages).toHaveLength(0);
    expect(existsSync(file)).toBe(false);
  });

  it("JSON 损坏 / 字段畸形的文件按空会话处理，下次 append 覆盖", () => {
    const store = makeStore();
    store.appendUserMessage("s10", "先制造文件");
    const file = fileFor(store, "s10");
    writeFileSync(file, "{ 这不是合法 JSON", "utf8");
    expect(store.load("s10")).toMatchObject({ user_messages: [], tool_calls: [], flags: [] });
    store.appendUserMessage("s10", "覆盖后");
    expect(store.load("s10").user_messages).toEqual(["覆盖后"]);

    writeFileSync(file, JSON.stringify({ user_messages: "非数组", tool_calls: [{ tool: 1 }], flags: [{ kind: "k" }] }), "utf8");
    expect(store.load("s10")).toMatchObject({ user_messages: [], tool_calls: [], flags: [] });
  });
});

describe("非法输入（fail-early，抛 SessionStoreError）", () => {
  it("session_id 空 / 全空白 / 超长 → 抛错，不落盘", () => {
    const store = makeStore();
    expect(() => store.appendUserMessage("", "x")).toThrow(SessionStoreError);
    expect(() => store.appendUserMessage("   ", "x")).toThrow(SessionStoreError);
    expect(() => store.load("x".repeat(513))).toThrow(SessionStoreError);
    expect(() => store.snapshot("")).toThrow(SessionStoreError);
    expect(readdirSync(store.dir)).toHaveLength(0);
  });

  it("append 参数形状非法 → 抛错", () => {
    const store = makeStore();
    expect(() => store.appendUserMessage("s11", "")).toThrow(SessionStoreError);
    expect(() =>
      store.appendToolCall("s11", { tool: "", decision: "ALLOW" }),
    ).toThrow(SessionStoreError);
    expect(() =>
      store.appendToolCall("s11", { tool: "shell execute", decision: "MAYBE" as never }),
    ).toThrow(SessionStoreError);
    expect(() => store.appendFlag("s11", { kind: "", excerpt: "e", p: 0.5 })).toThrow(SessionStoreError);
    expect(() => store.appendFlag("s11", { kind: "k", excerpt: "e", p: 1.2 })).toThrow(SessionStoreError);
    expect(() => store.appendFlag("s11", { kind: "k", excerpt: "e", p: Number.NaN })).toThrow(SessionStoreError);
    expect(readdirSync(store.dir)).toHaveLength(0);
  });
});
