import type { ToolCall } from "../api/types.js";
import type { Judge, JudgeAnswers } from "./types.js";

/**
 * 配置 judge.enabled: false 时使用的默认实现。
 * 上层保证不调用它；assess 被调用即视为接线错误，fail-closed 抛错。
 */
export class NoopJudge implements Judge {
  assess(call: ToolCall): Promise<JudgeAnswers> {
    void call;
    return Promise.reject(new Error("judge disabled"));
  }
}
