/**
 * hook 主流程：宿主 payload（stdin JSON）→ 识别方言 → 归一为 ToolCall
 * → engine.check → 回译为宿主响应写 stdout。
 *
 * fail-closed 序列（不变量 5，任一环节失败都不放行）：
 *   payload 非 JSON / 非对象          → DENY
 *   方言不可识别                      → DENY（通用形状）
 *   归一化失败（缺字段 / 二次解析失败）→ DENY（宿主形状）
 *   engine 装配或判定抛错              → DENY（宿主形状）
 * 非 pre-tool-use 事件（OutOfScopeEvent）是唯一例外：不判定、直通放行。
 * 其中 UserPromptSubmit 类事件在放行前先把用户本人消息记录进 SessionStore
 * （D4：judge 的 user_requested 信号数据源；只记录、仍不送判定）。
 */
import type { Engine } from "../../src/engine/index.js";
import type { SessionStore } from "../../src/session/index.js";
import { detectDialect } from "./dialect.js";
import { createHookEngine } from "./engine.js";
import { NormalizeError, OutOfScopeEvent, normalizePayload } from "./normalize.js";
import { isRecord, parseHookPayload, readStdin } from "./payload.js";
import { allowThroughResponse, denyResponse, toHostResponse } from "./respond.js";
import type { HostResponse, NormalizedHook, StdioDialect } from "./types.js";

export interface EvaluateHookOptions {
  /** 入口按安装点位钉死方言；缺省则自动识别 */
  dialect?: StdioDialect;
  /**
   * 用户消息事件的记录目标；缺省回落 engine.session（装配时注入）。
   * 两者皆无 → 用户消息事件退化为纯直通（不记录也放行）。
   */
  session?: SessionStore;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function evaluateHook(
  payload: unknown,
  engine: Engine,
  options: EvaluateHookOptions = {},
): Promise<HostResponse> {
  if (!isRecord(payload)) {
    return denyResponse(options.dialect, "payload 不是 JSON 对象");
  }
  const dialect = options.dialect ?? detectDialect(payload);
  if (dialect === undefined) {
    return denyResponse(undefined, "无法识别宿主方言（hook_event_name 与特征字段均不匹配）");
  }
  if (dialect === "opencode" || dialect === "pi" || dialect === "acp") {
    return denyResponse(undefined, `${dialect} 不是 stdin hook 方言，请走对应适配器入口`);
  }

  let normalized: NormalizedHook;
  try {
    normalized = normalizePayload(payload, dialect);
  } catch (error) {
    if (error instanceof OutOfScopeEvent) {
      // 用户本人消息事件（UserPromptSubmit）：记录进 session 后直通放行。
      // 记录失败降级为纯直通——丢一条用户消息是 judge 的信号损失，
      // 不构成当前请求的放行风险（不变量 5 约束的是判定路径而非辅助状态）。
      if (error.userMessage !== undefined) {
        const store = options.session ?? engine.session;
        if (store !== undefined) {
          try {
            store.appendUserMessage(error.userMessage.sessionId, error.userMessage.text);
          } catch {
            /* session 写盘失败不阻断放行 */
          }
        }
      }
      return allowThroughResponse(dialect, error.message);
    }
    if (error instanceof NormalizeError) {
      return denyResponse(dialect, `payload 归一化失败：${error.message}`);
    }
    throw error;
  }

  try {
    const decision = await engine.check(normalized.call);
    return toHostResponse(dialect, normalized.event, decision);
  } catch (error) {
    // engine.check 设计上不抛（内部 fail-closed）；此分支是双保险
    return denyResponse(dialect, `判定异常：${errorMessage(error)}`);
  }
}

/**
 * stdin/stdout hook 入口（各 integrations/<host>/index.ts 调用）。
 * 引擎装配失败时无法走正常流程，直接在钉死的方言里回 DENY。
 */
export async function runHookEntry(
  dialect: StdioDialect,
  configPath?: string,
): Promise<void> {
  const raw = await readStdin();
  let result: HostResponse | undefined;
  let engine: Engine | undefined;
  try {
    engine = createHookEngine(configPath);
    let payload: Record<string, unknown> | undefined;
    try {
      payload = parseHookPayload(raw);
    } catch (error) {
      result = denyResponse(dialect, errorMessage(error));
    }
    if (payload !== undefined) {
      result = await evaluateHook(payload, engine, {
        dialect,
        ...(engine.session !== undefined ? { session: engine.session } : {}),
      });
    }
  } catch (error) {
    result = denyResponse(dialect, `网关初始化失败：${errorMessage(error)}`);
  } finally {
    if (engine !== undefined) {
      // 关队列落盘审计是 best effort，不能让响应丢失
      await engine.close().catch(() => undefined);
    }
  }
  const final = result ?? denyResponse(dialect, "网关内部错误：响应未生成");
  process.stdout.write(final.stdout + "\n");
  if (final.stderr !== undefined) {
    // grok-build 契约：DENY 走 exit 2 + stderr 兜底（stdout JSON 损坏时
    // stderr 首行仍被宿主当作阻断原因）
    process.stderr.write(final.stderr + "\n");
  }
  process.exitCode = final.exitCode;
}
