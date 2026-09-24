/**
 * AgentFence 统一判定契约 v1。
 * 权威解释：.agents/notes/implemented/architecture/2026-09-23-tool-call-decision-model.md
 */

export type DecisionKind = "ALLOW" | "REVIEW" | "DENY";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** 作出最终判定的管线层级，用于审计与调参溯源 */
export type DecisionLayer =
  | "acl"
  | "parser"
  | "rules"
  | "policy"
  | "judge"
  | "approval";

export interface ToolRef {
  name: string;
  action: string;
  category?: string;
}

export interface CallContext {
  environment?: string;
  target?: string;
  cwd?: string;
  /** 由网关侧裁定；调用方自报值只能压更低 */
  trust_level?: number;
  task_token?: string;
}

/** 不可信内容命中（kind 类目 + 可疑摘录 + 校准概率），由网关侧内容扫描写入 */
export interface FlaggedUntrusted {
  kind: string;
  excerpt: string;
  p: number;
}

/**
 * 会话上下文：judge 的 user_requested / from_untrusted 信号数据源（D4）。
 * 由 src/session/ SessionStore.snapshot() 产出、engine 在判定前注入，
 * 一律覆盖调用方自报值（不变量 3）；三类字段皆空时整体缺省：
 * - user_intent        最近 ≤3 条用户本人消息按 "\n" 连接（每条截 700 字符）。
 *                      只收录 UserPromptSubmit 类事件；agent 自述与 tool result
 *                      永不算用户发言（不变量 4 及其亲属条款）;
 * - recent_tool_calls  最近 ≤6 次调用，形如 "shell execute → DENY（rm -rf /）";
 * - flagged_untrusted  最近 ≤5 条不可信内容命中。
 */
export interface SessionContext {
  user_intent?: string;
  recent_tool_calls?: string[];
  flagged_untrusted?: FlaggedUntrusted[];
}

/** 适配器归一后的统一判定输入 */
export interface ToolCall {
  request_id: string;
  agent_id: string;
  session_id?: string;
  run_id?: string;
  tool: ToolRef;
  input: Record<string, unknown>;
  /** 参数的 sha256；审计与缓存键用，不落原文 */
  input_digest?: string;
  context?: CallContext;
  session?: SessionContext;
}

export interface Decision {
  decision: DecisionKind;
  risk: RiskLevel;
  confidence: number;
  matched_rules: string[];
  decision_layer: DecisionLayer;
  reason: string;
  latency_ms?: number;
  policy_version?: string;
}

/** POST /v1/check 的请求/响应 */
export interface CheckRequest {
  agent: string;
  tool: string;
  action: string;
  input: Record<string, unknown>;
  context?: CallContext;
}

export type CheckResponse = Decision;

/** Parser 产出的单个子命令（已 unquote、已解析重定向与环境变量） */
export interface ParsedCommand {
  executable: string;
  args: string[];
  redirects: {
    stdin?: string;
    stdout?: string;
    stderr?: string;
    append?: boolean;
  };
  env: Record<string, string>;
  /** eval / bash -c / base64 解码执行 / 写文件再执行等间接执行迹象 */
  indirect: boolean;
  /**
   * 解包时被剥掉的包装命令（sudo / env / timeout / nice / nohup / stdbuf /
   * command / builtin），审计溯源用；无包装时缺省。
   * 多层包装按剥壳顺序以 ">" 连接（如 "sudo>timeout"）。
   */
  wrapper?: string;
}

/** 一条 shell 输入按 && ; | 子 shell 切分后的全部子命令 */
export interface ParsedShell {
  commands: ParsedCommand[];
}
