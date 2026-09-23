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

export interface FlaggedUntrusted {
  kind: string;
  excerpt: string;
  p: number;
}

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
}

/** 一条 shell 输入按 && ; | 子 shell 切分后的全部子命令 */
export interface ParsedShell {
  commands: ParsedCommand[];
}
