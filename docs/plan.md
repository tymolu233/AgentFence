# 任务计划

目标：按 `docs/references.md` 的路线，第一周完成调研，随后交付 v0.1 最小闭环（`主流 Agent → AgentFence → ALLOW/REVIEW/DENY`）。

## Phase A — 调研（第 1 周，时间盒）

固定产出格式：每个项目一份报告进 `docs/research/`，含三节——**Tool Call 数据结构**、**决策流程（Hook/Gateway 边界）**、**可借鉴点 / 不可照抄点**；引用须带 `file:line`。调研报告不是决策笔记；调研催生的拍板才进 `.agents/notes/`。

| ID | 任务 | 时间盒 | 产出 | 状态 |
|---|---|---|---|---|
| A1 | 深读 [leepokai/jev-guard](https://github.com/leepokai/jev-guard)（`src/ hooks/ extensions/`） | 1–2 天 | `docs/research/jev-guard.md` | 完成 |
| A2 | 深读 [hexitlabs/vigil](https://github.com/hexitlabs/vigil)（`checkAction` 与规则表） | 1–2 天 | `docs/research/vigil.md` | 完成 |
| A3 | 深读 [Deepint-Shield/ai-security](https://github.com/Deepint-Shield/ai-security)（Gateway/PDP 边界、`/decide`） | 1–2 天 | `docs/research/deepintshield.md` | 完成 |
| A4 | 速读 [LegionForge/guardian](https://github.com/LegionForge/guardian)（7 个确定性检查、Task token ACL、Tool Registry） | 半天 | `docs/research/guardian.md` | 完成 |
| A5 | 速读 [WhitzardAgent/AgentGuard](https://github.com/WhitzardAgent/AgentGuard)（GPL-3.0，只看思路）+ [hidearmoon/agentguard](https://github.com/hidearmoon/agentguard) | 半天 | `docs/research/agentguard.md` | 完成 |
| A6 | 提取 [roboticforce/agent-guardrails](https://github.com/roboticforce/agent-guardrails) 规则库：DENY/REVIEW 清单与易绕过模式 | 半天 | `docs/research/agent-guardrails.md`（40 条候选规则） | 完成 |
| A7 | 综合拍板：Tool Call 数据结构 v1 + 规则格式 v1 + 核心语言选型（TypeScript） | 1 天 | `docs/research/synthesis.md` → 四篇 implemented 笔记 | 完成 |

## Phase B — v0.1 骨架（TypeScript，Node ≥22，strict）

公共约束：所有模块先读 `docs/research/synthesis.md` 与 `.agents/notes/implemented/architecture/` 四篇笔记；统一类型用 `src/api/types.ts`；`npm run lint && npm run typecheck && npm test` 必须全绿；禁止新增依赖（`yaml` 已预装）。

| ID | 任务 | 产出路径 | 状态 |
|---|---|---|---|
| B1 | 核心骨架：package.json / tsconfig strict / eslint typechecked / vitest / 目录结构 | 根配置 + `src/*` | 完成 |
| B2 | 统一类型：`ToolCall` / `Decision` / `CheckRequest` / `ParsedShell` | `src/api/types.ts` | 完成 |
| B3 | 规则引擎（loader + 结构化 matcher + priority/deny-overrides 仲裁）+ 首批 40 条 YAML 规则（来源 A6 清单，文件头带 MIT 归属） | `src/rules/`、`rules/*.yaml` | 完成 |
| B4 | Shell parser：词法解析 → `ParsedShell`（unquote、`&&`/`;`/`|`/子 shell 切分、重定向、env、间接执行识别） | `src/parser/` | 完成 |
| B5 | Policy 引擎：接口 + 内置环境策略（sandbox/production），纯函数；OPA 后置 | `src/policy/`、`policies/` | 完成 |
| B6 | Judge 接口 + noop（默认关闭）+ 阈值纯函数（from_untrusted 一票否决最优先；user_requested 永不解 DENY） | `src/judge/` | 完成 |
| B8 | 审计：JSONL append-only + 哈希链 + 异步三档背压（best_effort/durable/fail_closed）+ 密钥脱敏 | `src/audit/` | 完成 |
| B7 | Engine 编排管线（ACL→Parser→Rules→Policy→Judge→Audit）+ CLI `agentfence check` | `src/engine/`、`src/cli/` | 进行中（agent） |
| B9 | **主流 Agent hook 适配**：统一 stdin/stdout JSON 归一层 + 各家方言映射 + 按宿主能力降级。覆盖 OpenCode / Claude Code / Codex CLI / Gemini CLI / Cursor | `integrations/{core,opencode,claude-code,codex,gemini-cli,cursor}` | 完成 |
| B10 | `docs/testing.md` 测试政策 + `scripts/verify/` 机械规则 4 条（类型逃逸/裸命令匹配/文档预算/新增依赖）进 CI | 文档 + 脚本 | 完成 |

## Phase C — 适配扩展（v0.2–v0.3，依赖 B9 验证适配器模式）

| ID | 任务 | 产出 | 状态 |
|---|---|---|---|
| C1 | Generic SDK 接入示例（LangChain 等任意框架，Tier 3） | `examples/` | 待办 |
| C2 | 二线宿主补充适配：Copilot CLI / ACP 代理 / pi + Grok CLI 调研与适配（官方仓库已 404，按社区延续版 superagent-ai/grok-cli 实现） | `integrations/{copilot,acp,pi,grok-cli}` | 完成 |
| C3 | MCP 拦截（**按需触发**，见下） | `integrations/mcp` | 暂缓 |
| C4 | ~~Pentest Policy 与 Target Authorization~~ | — | 暂缓 |

**C4 暂缓理由**（2026-09-23 用户决定）：pentest / 网络安全方向先不开发，资源集中在通用执行安全边界。原有设计（vision §17 分级梯子、target 授权）保留在 `docs/vision.md`，重启时直接引用。

**C3 暂缓理由**（2026-09-23 讨论）：五家 Tier-1 宿主的 hook 已覆盖 MCP 来源的 tool call（MCP 工具在 PreToolUse 里就是普通 `mcp__server__tool` 调用），MCP 代理拦截的是同批流量；其独有价值在 server 端信任（tool schema 钉住、行为漂移检测），属另一威胁模型。触发条件：出现只有 MCP 没有 hook 的目标宿主，或启动 server 端信任功能；届时按 hidearmoon 的 stdio 代理模式做轻量拦截，不做网关产品。

## v0.1 验收

1. `agentfence check --tool shell --command "rm -rf /"` → DENY，`agentfence check --tool shell --command "ls"` → ALLOW；
2. 每次判定（含 ALLOW）写入审计日志；
3. `npm run lint && npm run typecheck && npm test` 与 `scripts/check` 全绿；
4. 五家主流 Agent 的 hook 适配各有归一化 + 决策回译的测试（用各家真实 payload 样例）。

## 分工原则

- 调研报告、规则提取、骨架与独立模块 → 可派 agent 并行（任务边界以文件路径隔离，agent 不提交 git）。
- 决策拍板（A7，含语言选型）、规则条目终审、对外接口定稿 → 人来定，agent 只出草案。
