# 测试政策

断言走真实入口、外部重验；只 mock 贵/不确定的边界；对外可见输出固化为快照。

## 分层

| 层 | 覆盖 | 形态 |
|---|---|---|
| 纯函数 | 判定逻辑（judge 阈值函数、policy 求值、matcher 仲裁、parser） | 表驱动单测，零 I/O；判定函数不允许出现任何 I/O 依赖 |
| 模块 | loader / audit 落盘与链校验 / 背压队列 | vitest，文件系统走临时目录（`fs.mkdtemp`） |
| 规则即规格 | `rules/*.yaml` 每条规则的 `tests.deny` / `tests.allow` | 进 CI；改规则必须同步样例，规则 tests 红 = CI 红 |
| 端到端 | CLI `agentfence check` | 真实子进程跑真实命令字符串，断言退出码与 stdout JSON |
| 不变量回归 | 六条不变量的顺序敏感用例（from_untrusted 最优先、user_requested 永不解 DENY） | 永不可删；删除视同破坏安全契约 |

## 硬规则

1. **禁止 mock 被测层本身**：parser 的测试不得 mock 词法器，engine 的测试不得 mock engine；LLM/Judge、时钟、文件系统是允许注入的边界。
2. **规则绕过案例进回归**：`docs/research/agent-guardrails.md`"易绕过模式"一节的每个案例都要有对应 parser 或 matcher 测试。
3. **fail-closed 路径必须测**：非法 YAML、解析失败、策略缺失、审计队列满——每条都要断言拒绝而非放行。
4. **快照**：CLI 输出与 HTTP 响应形状用快照；改快照与改代码同 PR。
5. **无网络可回放**：默认套件（`npm test`）不访问外网；调研报告只作设计依据，不进测试依赖。**唯一例外**是 live 套件 `src/**/*.live.test.ts`（`npm run test:live`）：opt-in、打真实外部 API（如 JevJudge → Jev）、依赖真实凭证（`JEV_API_KEY` 或仓库根 `.env`，无凭证时整个文件 skip），不进默认套件、不进 CI；断言只限基本合理性（档位顺序 / 值域 / confidence 存在），不断言模型精确输出。默认套件通过 `vitest run --exclude "**/*.live.test.ts"` 在 vitest 默认排除之上追加排除，永远无网络。需要代理的网络用 `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 npm run test:live`（Node ≥22.14）。

## 门槛

- 新增代码变更行覆盖率 100%（`npm run coverage` + diff-cover，CI L1 门禁，见 `.github/workflows/ci.yml`）。
- `npm run lint && npm run typecheck && npm test` 全绿才允许合并。
