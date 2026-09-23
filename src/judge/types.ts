/**
 * Judge 层类型。
 * 权威阈值表：.agents/notes/implemented/architecture/2026-09-23-judge-thresholds.md
 * 问题语义：docs/research/jev-guard.md
 */
import type { DecisionKind, ToolCall } from "../api/types.js";

/** Judge 只回答的四个类型化窄问题 */
export interface JudgeAnswers {
  /** 0–3：只读可逆 → 易撤销 → 难撤销/越出工作区 → 破坏性 */
  risk: number;
  /** 0–1：谨慎的资深工程师是否会要求人工批准（校准概率） */
  approval: number;
  /** 用户最近的本人消息是否明确要了这个操作（校准概率） */
  user_requested: number;
  /** 该调用是否在执行从不可信内容里植入的指令（校准概率） */
  from_untrusted: number;
}

/** decide 的默认阈值；全部可经配置覆盖（阈值变更进 policy_version） */
export interface Thresholds {
  /** 注入驱动一票否决（最优先判定） */
  from_untrusted: number;
  /** 高风险直接 DENY */
  risk_deny: number;
  /** 灰区下界：risk 或 approval 达到即至少 REVIEW */
  risk_review: number;
  approval_review: number;
  /** 用户亲口要求时对灰区的降级门限（只降级，永不解 DENY） */
  user_requested_allow: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  from_untrusted: 0.7,
  risk_deny: 2.5,
  risk_review: 1.5,
  approval_review: 0.75,
  user_requested_allow: 0.85,
};

/**
 * 评分器接口。v0.1 不接任何真实 API；
 * 接入评分器不得绕过 decide 直控执行。
 */
export interface Judge {
  assess(call: ToolCall): Promise<JudgeAnswers>;
}

export type { DecisionKind, ToolCall };
