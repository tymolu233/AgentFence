/**
 * 宿主能力矩阵与 REVIEW 降级策略。
 *
 * 三态决策不是每家宿主都接得住：ask（人工审批）只有 Claude Code、
 * Cursor 的 shell/MCP 事件、OpenCode 的 permission.ask 支持
 * （调研报告 src/hook.js:79-123 段"落地方式因宿主能力而异"）。
 * 无 ask 能力的点位必须显式降级，逐家取舍：
 *
 * | 宿主 / 事件                  | ask | REVIEW 降级                        |
 * |------------------------------|-----|------------------------------------|
 * | claude-code PreToolUse       | 有  | ask（原生）                        |
 * | codex PreToolUse             | 无  | 警告放行（systemMessage + allow）  |
 * | gemini-cli BeforeTool        | 无  | 警告放行（systemMessage + allow）  |
 * | cursor beforeShellExecution  | 有  | ask（原生）                        |
 * | cursor beforeMCPExecution    | 有  | ask（原生）                        |
 * | cursor preToolUse            | 无  | 警告放行（user_message + allow）   |
 * | opencode tool.execute.before | 无  | 阻断（throw，fail-closed）         |
 * | opencode permission.ask      | 有  | ask（原生，output.status = "ask"） |
 * | copilot PreToolUse           | 有  | ask（原生 permissionDecision）     |
 * | pi tool_call（有 UI）        | 有  | ask（适配器驱动 ctx.ui.confirm）   |
 * | pi tool_call（无 UI）        | 无  | 阻断（block，fail-closed）         |
 * | acp terminal/create 等       | 有  | ask（session/request_permission）  |
 * | grok-cli PreToolUse          | 无  | 阻断（exit 2 + stderr，fail-closed）|
 *
 * 降级取舍的理由：
 * - Codex / Gemini / Cursor preToolUse 选"警告放行"：沿用 jev-guard 在这些
 *   宿主的落地方式，REVIEW 多为写文件等常规操作，硬阻断会把宿主用到不可用；
 *   代价是中风险调用失去人工闸口 —— 由审计全量记录兜底（不变量 6）。
 * - OpenCode tool.execute.before 选"阻断"：throw 是该 hook 唯一的拦截手段，
 *   且 OpenCode 对危险工具自带权限提示，permission.ask 钩子在那里提供原生
 *   ask； REVIEW 在 before 里阻断与 pi "无 UI 时 ask 直接 block" 同族，
 *   符合 AgentFence fail-closed 姿态（不变量 5）。
 * - grok-cli 选"阻断"：hook 输出只有 approve/block 两档，且 additionalContext
 *   / reason 字段在当前版本无人消费（警告无处可达），REVIEW 静默放行无任何
 *   用户可见性 —— 不如 block（stderr 原因会送达 agent 转告用户）。
 */
import type { Decision } from "../../src/api/types.js";
import type { CursorEvent, HostDialect } from "./types.js";

export type ReviewDegradation = "ask" | "warn-and-allow" | "block";

export interface HostCapability {
  /** 宿主该事件是否支持 ask（人工审批） */
  ask: boolean;
  /** REVIEW 的落地方式 */
  review: ReviewDegradation;
  /** 降级理由（进响应消息与文档） */
  note: string;
}

const WITH_ASK: HostCapability = { ask: true, review: "ask", note: "宿主支持原生 ask" };

const MATRIX: Record<HostDialect, HostCapability & Partial<Record<CursorEvent, HostCapability>>> = {
  "claude-code": WITH_ASK,
  codex: {
    ask: false,
    review: "warn-and-allow",
    note: "Codex 无 ask 决策，REVIEW 降级为 systemMessage 警告放行",
  },
  "gemini-cli": {
    ask: false,
    review: "warn-and-allow",
    note: "Gemini CLI BeforeTool 无 ask 决策，REVIEW 降级为 systemMessage 警告放行",
  },
  cursor: {
    ...WITH_ASK,
    preToolUse: {
      ask: false,
      review: "warn-and-allow",
      note: "Cursor preToolUse 不支持 ask（beforeShellExecution/beforeMCPExecution 支持），REVIEW 降级为警告放行",
    },
  },
  opencode: {
    ask: false,
    review: "block",
    note: "tool.execute.before 无 ask 能力，REVIEW 按 fail-closed 降级为 throw 阻断；原生 ask 由 permission.ask 钩子承接",
  },
  copilot: {
    ...WITH_ASK,
    note: "Copilot CLI 的 PreToolUse 契约同 Claude Code 三档齐全（云端 agent 形态下宿主自身把 ask 当 deny 处理）",
  },
  pi: {
    ask: false,
    review: "block",
    note: "pi 无 UI（hasUI=false）时 REVIEW 按 fail-closed 降级为 block；有 UI 时适配器改经 ctx.ui.confirm 审批",
  },
  acp: {
    ...WITH_ASK,
    note: "ACP 客户端支持 session/request_permission，REVIEW 由代理向客户端发起审批",
  },
  "grok-cli": {
    ask: false,
    review: "block",
    note: "grok-cli hook 只有 approve/block 两档且无警告通道（additionalContext 无人消费），REVIEW 按 fail-closed 降级为 block（exit 2 + stderr）",
  },
};

export function capabilityFor(dialect: HostDialect, event?: string): HostCapability {
  const entry = MATRIX[dialect];
  if (dialect === "cursor" && event !== undefined) {
    const override = MATRIX.cursor[event as CursorEvent];
    if (override !== undefined) return override;
  }
  return entry;
}

/** 决策落地结果：宿主语义的三档 + 可选警告文本 */
export interface TranslatedDecision {
  kind: "allow" | "ask" | "deny";
  /** REVIEW 被降级（放行或阻断）时的用户可见警告 */
  warning?: string;
}

function summarize(decision: Decision): string {
  const rules =
    decision.matched_rules.length > 0 ? `；命中规则 ${decision.matched_rules.join(", ")}` : "";
  return `${decision.reason}（risk ${decision.risk}，layer ${decision.decision_layer}${rules}）`;
}

/** Decision → 宿主三档语义；REVIEW 按宿主能力降级，降级必带警告文本 */
export function translateDecision(decision: Decision, cap: HostCapability): TranslatedDecision {
  switch (decision.decision) {
    case "ALLOW":
      return { kind: "allow" };
    case "DENY":
      return { kind: "deny" };
    case "REVIEW":
      switch (cap.review) {
        case "ask":
          return { kind: "ask" };
        case "warn-and-allow":
          return {
            kind: "allow",
            warning: `⚠️ AgentFence REVIEW 降级放行：${summarize(decision)}。${cap.note}`,
          };
        case "block":
          return {
            kind: "deny",
            warning: `AgentFence REVIEW 降级阻断：${summarize(decision)}。${cap.note}`,
          };
      }
  }
}

export { summarize as summarizeDecision };
