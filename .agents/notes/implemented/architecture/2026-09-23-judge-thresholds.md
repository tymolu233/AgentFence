# Agent Note: Judge 阈值表与灰区节流

Status: implemented

## Problem

LLM 判定贵、有延迟、不确定，不能进热路径主决策链；但"上下文复杂"的调用确实需要风险信号。需要划清 Judge 与最终决策的边界。

## Decision

Judge 只回答类型化窄问题（risk 0–3、approval、user_requested、from_untrusted 三个校准概率），最终判定是纯函数（源自 jev-guard 阈值表，hidearmoon 灰区节流合并）：

```
DENY    if from_untrusted.p ≥ 0.70        # 注入驱动一票否决，最优先
DENY    if risk ≥ 2.5
ALLOW   if (risk ≥ 1.5 or approval ≥ 0.75) and user_requested.p ≥ 0.85   # 只降级，永不解 DENY
REVIEW  if risk ≥ 1.5 or approval ≥ 0.75
ALLOW   otherwise
```

且 Judge 只在规则与策略均未给出结论的灰区触发；v0.1 为 noop 接口、默认关闭；阈值走配置；`user_requested` 永不解除 DENY。

## Alternatives considered

- **LLM 直接裁决执行** — 违背 fail-closed，自始至终否决。
- **每个调用都过 Judge** — hidearmoon 的级联成本模型（规则 µs / 统计 µs / LLM ms~s）证明灰区触发足够。
- **jev-guard 式云端评分 API** — tool result 随之上传、fail-open 默认、~0.6s RTT，不符合本地网关定位。

## Consequences

正面：判定可单测、阈值可调、LLM 成本可控。代价：真实评分器接入前 Judge 层无产出。强制要求：接入评分器不得绕过该纯函数直控执行；阈值变更进 `policy_version`；该函数的顺序敏感测试（from_untrusted 最优先、user_requested 不解 DENY）永不可删。
