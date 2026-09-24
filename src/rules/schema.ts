/**
 * 规则 schema v1（规则即数据）。
 * 权威解释：.agents/notes/implemented/architecture/2026-09-23-rule-format-v1.md
 */

import type { RiskLevel } from "../api/types.js";

export const RULE_CATEGORIES = [
  "shell",
  "filesystem",
  "database",
  "cloud",
  "kubernetes",
  "git",
  "iac",
  "network",
  "credentials",
] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];

export const RULE_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];

export const RULE_ACTIONS = ["DENY", "REVIEW"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

/** severity → Decision.risk */
export const SEVERITY_TO_RISK: Record<RuleSeverity, RiskLevel> = {
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  critical: "CRITICAL",
};

/**
 * flag 期望值：
 * - true / "*"：存在即可（布尔开关或任意取值）
 * - 其他字符串：要求归一化后的值全等（值会去掉首尾引号、小写化）
 */
export type FlagExpectation = true | string;

/**
 * 结构化 match 子句。同一对象内字段取 AND；`any` 取 OR（最多嵌套一层）。
 *
 * - tool             命中 ToolCall.tool.name 或 tool.category（小写比较）
 * - argv0            可执行名（basename、去 .exe、小写后全等；列表为 OR）
 * - argv0_regex      对同一归一化 argv0 的有界正则（/.../flags 字面量）
 * - subcommand       位置参数前缀序列；元素支持 `*`/`?` glob
 * - flags            全部满足（归一化短 flag 拆分、单/双横线等价、别名折叠）
 * - flags_any        至少满足一项
 * - args_regex       有界正则，命中任一位置参数即真（内联 SQL 等；列表为 OR）
 * - target_guarded   语义谓词：位置参数含守卫目标（/、~、.、..、$HOME、裸 *、
 *                    /etc /usr 等系统目录及其子路径、Windows/MSYS 盘符根）
 * - destructive_find 语义谓词：find 的删除语义（-delete，或 -exec/-execdir 直调 rm）
 * - stdin_from       跨子命令谓词：本命令为无 argv 裸命令（stdin 载荷不可见），
 *                    且更早的子命令 argv0 属于列表（近似"shell 管道自 curl/wget"）
 */
export interface RuleMatch {
  tool?: string | string[];
  argv0?: string[];
  argv0_regex?: string;
  subcommand?: string[];
  flags?: Record<string, FlagExpectation>;
  flags_any?: Record<string, FlagExpectation>;
  args_regex?: string[];
  target_guarded?: boolean;
  destructive_find?: boolean;
  stdin_from?: string[];
  any?: RuleMatch[];
}

export interface RuleTests {
  deny: string[];
  allow: string[];
}

/** 规则。ALLOW 是"无命中"的默认语义，不写规则 */
export interface Rule {
  id: string;
  category: RuleCategory;
  severity: RuleSeverity;
  action: RuleAction;
  /** 显式仲裁序：数字小者先判 */
  priority: number;
  match: RuleMatch;
  refs: string[];
  tests: RuleTests;
  /** 加载时注入：来源 YAML 文件名（相对 rules/ 目录） */
  source_file: string;
}
