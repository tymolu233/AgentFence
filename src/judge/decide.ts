/**
 * 最终判定纯函数（源自 jev-guard 阈值表）：
 *
 *   DENY    if from_untrusted ≥ 0.70        # 注入驱动一票否决，最优先
 *   DENY    if risk ≥ 2.5
 *   ALLOW   if (risk ≥ 1.5 or approval ≥ 0.75) and user_requested ≥ 0.85   # 只降级，永不解 DENY
 *   REVIEW  if risk ≥ 1.5 or approval ≥ 0.75
 *   ALLOW   otherwise
 */
import type { DecisionKind, JudgeAnswers, Thresholds } from "./types.js";
import { DEFAULT_THRESHOLDS } from "./types.js";

export function decide(
  answers: JudgeAnswers,
  thresholds?: Partial<Thresholds>,
): DecisionKind {
  const t: Thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };

  if (answers.from_untrusted >= t.from_untrusted) return "DENY";
  if (answers.risk >= t.risk_deny) return "DENY";

  const gray =
    answers.risk >= t.risk_review || answers.approval >= t.approval_review;
  if (gray) {
    return answers.user_requested >= t.user_requested_allow
      ? "ALLOW"
      : "REVIEW";
  }
  return "ALLOW";
}
