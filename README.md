# AgentFence

本仓库按「反屎山工具包（Anti-ShiShan Kit）」初始化，开发规范按级别渐进落地。规范来源：对 DeepSeek Harness 开发规范与方法论的提炼（去掉了该仓库特有的规模假设）。

## 级别

- **Level 0 · 最小必做集** — 任何项目 Day 1：一条 CI 红线、一页规范、一个测试命令、PR 门禁。
- **Level 1 · 标准集** — 有 2+ 协作者或引入 AI agent：机械规则脚本化、变更行覆盖、快照测试、文档分层与字数预算、Agent Notes 决策笔记、推送前最小检查。
- **Level 2 · 全量集** — 大仓库 / AI 高参与度：核心逐文件 100% 覆盖、录制回放、baseline 冻结、生成式目录、决策记录生命周期、防御模式成文。

详见各文件头部的注释。

## 文件清单

| 文件 | 用途 | 级别 |
|---|---|---|
| `CONTRIBUTING.md` | 一页硬规则，放仓库根（或 AGENTS.md） | L0 |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR 门禁清单 | L0 |
| `.github/workflows/ci.yml` | 最小 CI 红线（按语言替换命令） | L0 |
| `scripts/check` | 推送前最小检查（按改动路径选检查集） | L0/L1 |
| `.agents/notes/README.md` | **Agent Notes 机制** | L1 |
| `.agents/notes/templates/` | proposed / implemented / rejected 三份填空模板 | L1 |
| `scripts/check-notes` | 笔记结构自检（POSIX sh 零依赖） | L1 |
| `.github/workflows/verify-notes.yml` | 笔记自检进 CI | L1 |
| `docs/notes-quality-gate.md` | 写完笔记后的语义自检（永不进脚本） | L1 |
| `docs/verify-rules.md` | 从口头规则到 verify 脚本的起手清单（多语言） | L1 |

## 落地路线

1. **第 1 周（L1）**：按 `docs/verify-rules.md` 挑最先犯的 3–5 条规则写成脚本进 `scripts/verify/`；`.agents/notes/` 笔记机制随仓库启用（三份模板起头，`scripts/check-notes` 已进 CI）。
2. 存量代码走 baseline 冻结：新代码达标，欠债进基线文件封增量，触碰时偿还。
