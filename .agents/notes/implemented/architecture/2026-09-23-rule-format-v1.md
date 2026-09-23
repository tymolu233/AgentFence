# Agent Note: 规则格式 v1 与 Parser 及格线

Status: implemented

## Problem

在拼接字符串上跑正则是可被 trivial 绕过的（Vigil 与 agent-guardrails 的实测绕过清单：引号拼接、参数换序、等效标志、等效命令、间接执行、子命令组合）。同时规则要支持社区贡献，必须是数据而非代码。

## Decision

规则为 YAML 数据，字段：`id / category（闭集：shell/filesystem/database/cloud/kubernetes/git/iac/network/credentials）/ severity（low/medium/high/critical）/ action（DENY|REVIEW）/ priority / match / refs / tests`。`match` 是结构化字段（tool、argv0、flags、语义谓词如 target_guarded），不是字符串模式。匹配语义：

- matcher 在 Parser 产出的 token 流（`ParsedShell`）上判定，字段路由（command 走 shell 规则、url 走 network 规则）；
- 显式 `priority`，多规则命中取最重（deny-overrides）；
- 每条规则自带 `tests`（deny/allow 样例），进 CI，规则即规格；
- 规则文件头部保留来源归属声明（首批源自 agent-guardrails，MIT）。

Parser 及格线（验收标准）：① shell 词法解析（unquote/解转义/token 重组）后才进匹配；② 切分 `&&` `;` `|` 与子 shell，逐子命令判定取最重 verdict；③ 间接执行（eval / bash -c / base64 -d | sh / 写文件再执行）启发式 REVIEW；④ URL parse 后判 host、路径 Clean 后判前缀；⑤ 配置外置属环境维度信号，不假装 parser 能解决。

## Alternatives considered

- **纯正则规则（Vigil 式）** — 绕过清单整节是否决证据。
- **手写 Rego 为唯一规则形态** — DeepintShield 的双轨表明结构化 AST 是快路径、Rego 是生成物；Rego 编译兜底后置到 Policy 层规划。

## Consequences

正面：规则可贡献、可测试、绕过面有据可查。代价：matcher 要为每个语义谓词写实现，比正则慢热。强制要求：改 parser 及格线 = 破坏规则契约，须同步全量规则 tests；新增 category 须同步本笔记与检查脚本。首批 40 条候选见 `docs/research/agent-guardrails.md`。
