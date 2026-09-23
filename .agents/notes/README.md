# Agent Notes — 决策笔记机制（可移植的 note 机制）

移植自 DeepSeek Harness 的 `.agents/notes/` 设计。本目录即是笔记的家；规则只在此处，其他文档只链接。

## 结构

```
.agents/notes/
├── README.md        # 本文件：格式与规矩（唯一权威）
├── proposed/        # 提案（严禁归档，要么推进要么转 rejected）
├── implemented/     # 已落地决定（现在时，现行法律）
├── rejected/        # 被否决定（冻结，防重犯）
├── archived/        # 封存（含 Implemented 归档；历史，永不当现行权威）
└── <class>/         # 以上每个生命周期下按 6 分类建子目录
```

路径恒为 `{lifecycle}/{class}/yyyy-mm-dd-topic.md`，分类是封闭集：

| class | 覆盖 |
|---|---|
| `feature` | 新增用户/模型可见能力 |
| `bug-fix` | 修缺陷或补复盘暴露的缺口 |
| `simplification` | 只删不增的清理（行为不变的重构也归此） |
| `architecture` | 结构性决定：模块边界、包依赖、运行时词汇 |
| `process` | 代码之外的工具链、门禁、发布流程 |
| `testing` | 测试基建与策略 |

加新 class 要同步改检查脚本——封闭集是故意的。

## 何时写（先判断，再动笔）

- 只写**代码、测试、普通文档解释不了的持久 rationale**：为什么、放弃了什么、后续强制要求。
- **与实现同一个 PR** 写入或更新，不事后补。
- 能自己查到的事实不写（入口注释、rg、模块文档）；只有取舍和拍板才留痕。
- **更新既有归属，禁止重复新建**：事实（路径、符号、默认值）就地改；决定或理由翻转 → 新开一篇并互链。一篇笔记永不被改写成另一个决定。
- 机械改动、局部 UI 改动豁免。

## 头块（检查脚本核对）

```markdown
# Agent Note: <标题>

Status: proposed            | implemented | rejected — <一句话原因>
（归档篇：Status 行紧下方加 Archived: YYYY-MM-DD）
```

第 1 行必须以 `# Agent Note:` 开头；`Status:` 全篇唯一且与所在生命周期目录一致。文件名日期是首次提出日，其余时间交给 git。

## 正文骨架

- 所有笔记以 `## Problem` 开头（动机脱离方案也能独立成立）。
- `proposed`：`## Proposal` + `## Alternatives considered`（必填，只写真实考虑过的对手方案）。
- `implemented`：`## Decision`（**现在时**）+ `## Alternatives considered` + `## Consequences`；禁用 `## Proposal`/`## Plan`/`## Acceptance criteria` 等计划态标题。
- `rejected`：`## Problem` + 冻结的 `## Proposal` + `## Alternatives considered` + `## Risks`（否决原因与重提条件）。
- 中英标题别名均可（`## 决策`、`## 备选方案`…），检查脚本按别名匹配。

## 生命周期

```
proposed ──落地──▶ implemented ──被取代──▶ archived（只插 Archived: 行）
   │
   └──前提消失──▶ rejected（严禁归档 proposed）
```

- **归档只增不改**：不重写、不当现行权威；互链写在新笔记里，不写进归档篇。
- **rejected 有寿命**：被否方案依赖的技术彻底移除、后人绝无可能再提时，删除（三件一起删并修链接）。
- 决定被完全取代：新笔记吸收全部独特 rationale 后才可合并删除旧篇，git 历史不是 rationale 的唯一副本。

## 门禁

`scripts/check-notes`（POSIX shell，零依赖）结构自检：路径/文件名、头块、Status 与目录一致、归档封印、implemented 无计划态标题、Alternatives 必写。语义好坏靠写完后的自检清单（见 [docs/notes-quality-gate.md](../../docs/notes-quality-gate.md)），**永不进脚本**。
