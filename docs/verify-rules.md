# 从口头规则到 verify 脚本：起手清单

方法论：团队反复口头提醒的规则 = 候选门禁。挑最先犯的 5 条开始，每条脚本自带单测，进 CI。

## 起手 Top 5（与语言无关）

| # | 规则 | 实现思路 |
|---|---|---|
| 1 | 禁止类型逃逸 | grep `as unknown` / `type:\s*ignore` / `nosec`，对比基线文件：存量允许、增量禁止 |
| 2 | 禁止空 catch | AST 扫描（非正则）：catch 块为空或只有注释即报错，要求命名错误 + 原因 |
| 3 | 导出必须有文档 | 解析导出符号，检查紧邻 doc comment 含参数/返回说明 |
| 4 | 文件以单个换行结尾 | 纯字节检查，配 git hook（`git diff --cached --check` 天然覆盖） |
| 5 | 文档禁状态词 | `implemented!`/`待完成`/`曾经`/`future:` 出现在 .md 即失败 |

## 进阶候选（L1→L2）

- 禁止跨模块裸字符串 ID（需类型/符号信息）
- 禁止散落默认值：`?? default` / `get(key, default)` 只允许出现在 `resolve()` 所在文件
- UI/用户可见文案禁止硬编码（走 i18n 字典或本地化 primitive）
- 一事实一归属：标志性短语全仓 grep，出现 >1 处即失败（其余必须是链接）
- 目录/清单类文档必须由生成器产出（生成后 `git diff --exit-code`）
- 文件末尾字数预算：超 `verify-doc-budgets` 清单上限即失败

## baseline 模式（存量项目的铁律）

```
baseline.json   # 存量违规的精确位置快照
check.py        # 实际违规 ⊆ baseline 才绿；新增违规红；baseline 只许缩小
```

规则因此可以 Day 1 生效，无需先大扫除。对应 DeepSeek Harness 的 `no-unknown-casts.baseline.json`。

## 多语言实现位

| 语言 | AST/检查工具 |
|---|---|
| TypeScript | ts-morph / oxlint 自定义规则 / ts eslint rule |
| Python | ruff custom rule / libcst / ast 模块 |
| Go | golangci-lint 自定义 linter / `go/ast` |
| Rust | clippy lint（cargo 子命令） |
| 通用 | pre-commit 钩子 + grep/rg 起步，先跑起来再升级 AST |

## 反门禁腐烂

- 每个 verify 脚本自己要有 `.spec.ts` 等价单测。
- 门禁失败的处理顺序固定：**归位 → 压缩 → 最后才在 PR 里论证放宽**；禁止习惯性放水。
