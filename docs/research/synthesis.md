# A7 综合拍板草案（待人审）

来源：`docs/research/` 六份调研报告（jev-guard / Vigil / DeepintShield / Guardian / AgentGuard×2 / agent-guardrails）。本文件是草案；拍板后结论转为 `.agents/notes/` 的 implemented 笔记，本文件保留作依据。

## 草案一：Tool Call 数据结构 v1

### 请求（适配器归一后的统一模型）

```json
{
  "request_id": "req_xxx",
  "agent_id": "opencode",
  "session_id": "session_xxx",
  "run_id": "run_xxx",
  "tool": { "name": "shell", "action": "execute", "category": "shell" },
  "input": { "command": "..." },
  "input_digest": "sha256:...",
  "context": {
    "environment": "sandbox",
    "target": "lab.example",
    "cwd": "/workspace",
    "trust_level": 3,
    "task_token": "jwt..."
  },
  "session": {
    "user_intent": "SQL injection testing",
    "recent_tool_calls": ["..."],
    "flagged_untrusted": [{ "kind": "injection", "excerpt": "...", "p": 0.82 }]
  }
}
```

字段来源：`agent/tool/input/context` 骨架取自 jev-guard 的归一结构；`input_digest`（sha256、审计与缓存键用、不落原文）取自 DeepintShield `ArgsDigest`；`trust_level` + `task_token` 取自 hidearmoon/Guardian；`session` 三块（意图/近期调用/注入命中摘录）取自 jev-guard。

### 响应（Decision v1）

```json
{
  "decision": "ALLOW",
  "risk": "LOW",
  "confidence": 0.98,
  "matched_rules": [],
  "decision_layer": "rules",
  "reason": "Read-only reconnaissance command",
  "latency_ms": 1.2,
  "policy_version": "2026-09-23.1"
}
```

- `decision_layer`：哪一层作出的判定（acl / parser / rules / policy / judge / approval），审计与调参必备（源自 hidearmoon `decision_engine` 溯源字段）。
- shadow/灰度模式下拆 `raw_decision` / `effective_decision` 两字段（Vigil 教训：降级后丢命中信息）。

### 不变量（六个项目共同验证过的红线）

1. **判定逻辑是进程内纯函数**，传输层只做薄适配（DeepintShield PDP 边界）。
2. **trust 由网关侧裁定，调用方只能自报更低**（hidearmoon）。
3. **运行时状态（调用序列、session）由网关侧维护，不信任调用方自报**（Guardian `sequence_so_far` 教训）。
4. **tool result 内容永不算用户发言**（jev-guard）。
5. **fail-closed**：解析失败、策略缺失、网关不可达（SDK 合成 DENY）默认拒绝（Guardian）；LLM/Judge 挂了默认行为显式可配，默认 fail-closed。
6. **审计全量（ALLOW 同记）、异步出热路径**（DeepintShield 三档背压：best_effort / durable / fail_closed）。

## 草案二：规则格式 v1

```yaml
- id: fs.rm-recursive-guarded-path
  category: filesystem            # 闭集：shell/filesystem/database/cloud/kubernetes/git/iac/network/credentials
  severity: critical              # low/medium/high/critical，闭集
  action: DENY                    # DENY | REVIEW（ALLOW 是"无命中"的默认，不写规则）
  priority: 100                   # 显式仲裁：数字小者先判；多规则命中取最重（deny-overrides）
  match:
    tool: shell                   # 或 category；字段路由：command 走 shell 规则、url 走 network 规则
    argv0: [rm]                   # 解析后的 token，不是字符串
    flags: { recursive: true }
    target_guarded: true          # 语义谓词：目标是 / ~ . 或工作区根
  refs: ["https://github.com/roboticforce/agent-guardrails (MIT)"]
  tests:
    deny: ["rm -rf /", "rm -rf ~", "rm -rf ."]
    allow: ["rm -rf ./node_modules", "rm -r ./build"]
```

设计要点（每条都有出处）：

- **在解析后的 token 流上匹配**，不是原始字符串（A6 易绕过清单：引号拼接、参数换序、等效标志、子命令组合）。
- **规则自带 `tests`**：deny/allow 样例进 CI，规则即规格（六份报告都没有，是我们对它们的超越点）。
- **显式 `priority` + deny-overrides**（Vigil 隐式声明顺序仲裁的教训）。
- **首批 40 条候选规则已在 `docs/research/agent-guardrails.md`**，含 12 条建议降为 REVIEW 的条目；规则文件保留 MIT 归属声明。
- **类目表**沿用 A6 骨架（shell / filesystem / database / cloud / kubernetes / git / iac）+ network / credentials。

### Parser 及格线（A6 绕过清单 → 验收标准）

1. shell 词法解析：unquote/解转义/token 重组后才进匹配；
2. 切分 `&&` `;` `|` 子 shell，每个子命令独立判定，取最重 verdict；
3. 识别间接执行（`eval` / `bash -c` / `base64 -d | sh` / 写文件再执行）→ 启发式 REVIEW（与具体类目无关）；
4. URL 走 parse 后判 host（归一化、剥 userinfo），路径 Clean 后判前缀；
5. 配置外置（危险连接串藏在 .env/config）是规则层之外的信号，架构上标注为环境维度控制项，不假装 parser 能解决。

## 草案三：核心语言选型 → 建议 TypeScript

按选型笔记的三条标准，调研证据如下：

| 标准 | 证据 | 结论 |
|---|---|---|
| ① 主流 agent hook 分发成本 | Tier-1 目标（OpenCode / Claude Code / Codex / Gemini CLI / Cursor）全是 Node 生态，hook 形态是 stdin/stdout JSON 的 CLI 子进程（jev-guard 实测 8 家） | TS 零安装摩擦（npx），Python 次之，Go 需预编译分发 |
| ② 参考项目可借鉴度 | 最贴近的两个参考（jev-guard JS、Vigil TS）可代码级借鉴；Guardian/hidearmoon（Python）设计级借鉴；DeepintShield（Go）架构级借鉴 | TS 最高 |
| ③ 部署形态 | hook 子进程 + 长驻 Decision API 服务双形态都要；Node 冷启动 ~50ms 对 hook 场景够用（jev-guard 如此）；长驻服务 TS 无短板 | TS 满足 |

**建议：TypeScript 核心**（判定层 + CLI + hook 适配器一体，`npm` 分发），HTTP Decision API 为跨语言契约，Python SDK 在 Phase C 提供（Agent 框架生态）。Go 的重提条件保留在 rejected 笔记（若转向 sidecar 主战场）。

风险与对策：JS 正则有 ReDoS 面（Vigil `<!--[\s\S]*-->` 例）——规则匹配前做长度截断 + 结构化解析先行，正则是兜底而非主力，必要时上 RE2 binding。

### Judge 层节流策略（随语言一并定）

采用 jev-guard 阈值表 + hidearmoon 灰区节流的合并：

```
DENY    if from_untrusted.p ≥ 0.70        # 注入驱动一票否决，最优先
DENY    if risk ≥ 2.5
ALLOW   if (risk ≥ 1.5 or approval ≥ 0.75) and user_requested.p ≥ 0.85   # 只降级，永不解 DENY
REVIEW  if risk ≥ 1.5 or approval ≥ 0.75
ALLOW   otherwise
```

且 **Judge 只在规则+策略未给出结论的灰区触发**（hidearmoon 0.6–0.85 才调 LLM 的节流思路），v0.1 judge 为 noop 接口、默认关闭。

## 拍板清单（请逐项确认或修改）

1. [ ] Tool Call / Decision 数据结构 v1（含六条不变量）
2. [ ] 规则格式 v1（含 priority / tests / refs 字段与 parser 及格线）
3. [ ] 语言：TypeScript 核心 + HTTP API + Python SDK（Phase C）
4. [ ] Judge 阈值表与"灰区才触发"节流

全部确认后：上述结论转为 implemented 笔记，`docs/plan.md` A7 标完成，Phase B（骨架开发）解锁。
