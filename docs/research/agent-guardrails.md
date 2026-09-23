# agent-guardrails 调研报告（A6）

- **仓库**：https://github.com/roboticforce/agent-guardrails
- **Commit**：`93d315c78a7cec0ea9eeb8d11fb4a2bb1f021386`（2026-07-29，`git clone --depth 1` 头提交）
- **License**：**MIT**（`LICENSE`，Copyright (c) 2026 RoboticForce, Inc.）。宽松许可，规则内容（命令清单/类目划分）可自由复用与改写，唯一约束是再分发时保留版权声明；无 copyleft、无额外条款。
- **语言/形态**：纯 Bash guard 脚本（6 个，每个 ~50-70 行）+ Claude Code `settings.json` deny 规则清单（49 条 glob）+ `policies/` 策略说明文档 + 2 篇真实事故复盘。无运行时服务。

定位：挂在 Claude Code 的 PreToolUse 上的**硬阻断**层。两层机制：① settings.json 的 glob deny（锚定命令前缀，匹配则 Tool Call 直接不执行）；② 6 个 bash 脚本用 jq 从 stdin 解析 `tool_input.command`，再拿一组 ERE 模式做 `grep -qiE` 子串匹配，命中则 exit 2。判定只有二元（block / allow），没有 REVIEW 概念。每条规则基本都能溯源到一个真实事故（terraform destroy 毁 RDS 及快照、prisma `--shadow-database-url` 清掉整个 prod Supabase），这是它最大的价值：**规则是被事故验证过的集合**。

我们只提取其规则内容与判定智慧，不采用其实现。下面把全部判定条件重写为 AgentFence 的 YAML 形状（`id / category / severity / match / action`），DENY/REVIEW 为我们的建议（与其硬阻断不一致处单独注明）。

## 规则候选清单

共 **40 条**候选规则。来源均为上述 deny 清单与 guard 脚本，合并了同族冗余模式。

### shell（4 条，来源 cloud-guard.sh 尾部"Generic" + settings.json）

```yaml
- {id: shell.dd-write-device, severity: critical, action: DENY,
   match: "dd 命令的输出目标是块设备（of=/dev/*）",
   example: "dd if=/dev/zero of=/dev/sda"}
- {id: shell.format-device, severity: critical, action: DENY,
   match: "调用 mkfs 系格式化工具（mkfs.ext4/xfs/... 任意文件系统）",
   example: "mkfs.ext4 /dev/sda1"}
- {id: shell.partition-tool, severity: high, action: REVIEW,
   match: "调用磁盘分区工具（fdisk 等）操作块设备；注意 REVIEW 为本项目建议，来源是硬阻断",
   example: "fdisk /dev/sda"}
- {id: shell.docker-prune-all, severity: high, action: REVIEW,
   match: "docker system prune 加 -a/--all（删除全部未用镜像/容器/网络）；来源硬阻断 `docker system prune -a`",
   example: "docker system prune -a --volumes"}
```

### filesystem（1 条，来源 settings.json）

```yaml
- {id: fs.rm-recursive-guarded-path, severity: critical, action: DENY,
   match: "rm 带递归强制删除且目标为危险根位置（/、~、当前目录整体、工作区根）",
   example: "rm -rf / ; rm -rf ~ ; rm -rf ."}
```

### database（13 条，来源 database-guard.sh / prisma-guard.sh / settings.json / policies/databases.md）

```yaml
- {id: db.sql-drop-database, severity: critical, action: DENY,
   match: "命令文本中出现 DROP DATABASE 语句（大小写不敏感），含 mysql -e / psql -c 内联执行",
   example: "mysql -e 'DROP DATABASE shop' ; psql -c \"drop database prod\""}
- {id: db.sql-drop-table, severity: critical, action: DENY,
   match: "命令文本中出现 DROP TABLE 语句",
   example: "psql -c 'DROP TABLE users'"}
- {id: db.sql-drop-schema, severity: critical, action: DENY,
   match: "命令文本中出现 DROP SCHEMA 语句（PG/SQL Server）",
   example: "DROP SCHEMA public CASCADE"}
- {id: db.sql-truncate, severity: high, action: DENY,
   match: "命令文本中出现 TRUNCATE 语句（来源对 TRUNCATE 一刀切硬阻断，含大小写变体）",
   example: "TRUNCATE TABLE sessions"}
- {id: db.sql-delete-all-rows, severity: high, action: REVIEW,
   match: "DELETE FROM 无实际 WHERE 条件（WHERE 1=1 恒真条件 / 完全无过滤）；来源用正则无差别匹配，建议归为 REVIEW 降低误报",
   example: "DELETE FROM sessions WHERE 1=1"}
- {id: db.pg-dropdb, severity: critical, action: DENY,
   match: "调用 PostgreSQL 删库工具 dropdb",
   example: "dropdb production"}
- {id: db.redis-flush, severity: critical, action: DENY,
   match: "redis-cli 执行 FLUSHALL / FLUSHDB",
   example: "redis-cli -h prod FLUSHALL"}
- {id: db.mongo-drop-database, severity: critical, action: DENY,
   match: "mongosh/mongo 执行 db.dropDatabase() 或集合级 drop",
   example: "mongosh prod --eval 'db.dropDatabase()'"}
- {id: db.prisma-shadow-database-url, severity: critical, action: DENY,
   match: "命令行出现 --shadow-database-url 标志（不论其值为何）；来源事故：Opus 5 将该标志指向 prod 连接串，Prisma reset 影子库时清光全部表",
   example: "prisma migrate diff --shadow-database-url=$DATABASE_URL"}
- {id: db.prisma-migrate-reset, severity: critical, action: DENY,
   match: "prisma migrate reset、migrate --force、db push --force-reset（drop 并重建库）",
   example: "prisma db push --force-reset"}
- {id: db.prisma-accept-data-loss, severity: high, action: DENY,
   match: "prisma 任意子命令携带 --accept-data-loss 标志",
   example: "prisma db push --accept-data-loss"}
- {id: db.orm-drop-reset, severity: critical, action: DENY,
   match: "其他 ORM/迁移工具的删库重建命令：rails/rake db:drop、db:migrate:reset、typeorm schema:drop、flyway clean",
   example: "rails db:drop ; flyway clean"}
- {id: db.orm-revert-rollback, severity: high, action: REVIEW,
   match: "迁移回滚类命令：alembic downgrade、sequelize migrate:undo、knex migrate:rollback、typeorm migration:revert、flyway undo；来源一律硬阻断，但回滚在 dev 属常规操作，建议 REVIEW",
   example: "alembic downgrade -1 ; knex migrate:rollback"}
```

### cloud（6 条，来源 cloud-guard.sh / settings.json / policies/cloud-providers.md）

```yaml
- {id: cloud.aws-compute-terminate, severity: critical, action: DENY,
   match: "aws ec2 terminate-instances",
   example: "aws ec2 terminate-instances --instance-ids i-0abc123"}
- {id: cloud.aws-data-delete, severity: critical, action: DENY,
   match: "AWS 数据面删除：rds delete-db-instance/cluster/snapshot、elasticache 系删除、s3 rb、s3 rm --recursive",
   example: "aws rds delete-db-instance --db-instance-identifier prod --skip-final-snapshot"}
- {id: cloud.aws-stack-teardown, severity: critical, action: DENY,
   match: "AWS 编排级拆除：cloudformation delete-stack、ecs/eks delete-cluster（ecs delete-service 建议 REVIEW 另放）、route53 delete-hosted-zone、lambda delete-function",
   example: "aws cloudformation delete-stack --stack-name prod"}
- {id: cloud.gcp-resource-delete, severity: critical, action: DENY,
   match: "gcloud 删除计算/数据资源：compute instances delete、sql instances delete、container clusters delete、projects delete、app services delete",
   example: "gcloud projects delete my-prod-project"}
- {id: cloud.azure-resource-delete, severity: critical, action: DENY,
   match: "az 删除资源：vm delete、sql db/server delete、group delete（整个资源组）、aks delete、webapp delete",
   example: "az group delete --name production-rg"}
- {id: cloud.digitalocean-delete, severity: high, action: DENY,
   match: "doctl 删除资源：droplet/database/kubernetes cluster/volume delete",
   example: "doctl database delete prod-db"}
```

### kubernetes（5 条，来源 kubernetes-guard.sh / policies/kubernetes.md）

```yaml
- {id: k8s.delete-namespace, severity: critical, action: DENY,
   match: "kubectl delete namespace/ns（整命名空间连锅端，含 secrets/PVC）",
   example: "kubectl delete namespace production"}
- {id: k8s.delete-bulk-all, severity: critical, action: DENY,
   match: "kubectl delete 带 --all 的批量删除（跨资源类型或对某类资源全量）",
   example: "kubectl delete pods --all -n default ; kubectl delete --all --all-namespaces"}
- {id: k8s.delete-from-manifest, severity: high, action: REVIEW,
   match: "kubectl delete -f/--filename（按清单批量删除，一次可删多个资源）；来源硬阻断，建议 REVIEW 因日常删除单个对象合法",
   example: "kubectl delete -f k8s/prod-stack.yaml"}
- {id: k8s.drain-force, severity: high, action: REVIEW,
   match: "kubectl drain 带 --force 或 --delete-emptydir-data（强制驱逐可致业务中断/数据丢失）；来源硬阻断且连 cordon 一起拦，cordon 本身可逆，不建议收录",
   example: "kubectl drain node-1 --force --delete-emptydir-data"}
- {id: k8s.helm-uninstall, severity: high, action: REVIEW,
   match: "helm uninstall/delete（删除整个 release 及其资源，可含 PVC）；来源硬阻断",
   example: "helm uninstall postgres -n data"}
```

### git（5 条，来源 git-guard.sh / settings.json / policies/git.md）

```yaml
- {id: git.force-push-protected, severity: high, action: DENY,
   match: "向受保护分支（main/master/production）force push，含 -f/--force/--force-with-lease 及 flags 任意位置",
   example: "git push --force-with-lease origin main ; git push origin main -f"}
- {id: git.reset-hard, severity: medium, action: REVIEW,
   match: "git reset --hard（永久丢弃未提交改动）；来源硬阻断，但属本地日常操作，建议 REVIEW",
   example: "git reset --hard HEAD~3"}
- {id: git.clean-force, severity: medium, action: REVIEW,
   match: "git clean -fd/-fx（永久删除未跟踪文件）",
   example: "git clean -fdx"}
- {id: git.discard-all-changes, severity: medium, action: REVIEW,
   match: "丢弃整个工作树改动的命令：git checkout -- . / git restore .",
   example: "git checkout -- ."}
- {id: git.branch-force-delete-protected, severity: medium, action: REVIEW,
   match: "git branch -D 删除受保护分支（main/master/production）；来源硬阻断",
   example: "git branch -D main"}
```

### iac（6 条，来源 terraform-guard.sh / settings.json / policies/terraform.md）

```yaml
- {id: iac.terraform-destroy, severity: critical, action: DENY,
   match: "terraform/tofu/terragrunt 的 destroy 子命令；来源事故：对含 prod state 的目录 destroy，连 RDS 与自动快照一并删除",
   example: "terraform destroy ; terragrunt destroy"}
- {id: iac.apply-auto-approve, severity: critical, action: DENY,
   match: "terraform/tofu/terragrunt apply 带 -auto-approve/--auto-approve（跳过人工确认）",
   example: "terraform apply -auto-approve"}
- {id: iac.state-mutation, severity: critical, action: DENY,
   match: "terraform/tofu state rm / state push（改 state 造成漂移或覆盖远端 state）",
   example: "terraform state rm aws_db_instance.prod"}
- {id: iac.state-force-unlock, severity: high, action: REVIEW,
   match: "terraform force-unlock（绕过 state 锁，可能引发并发写 state 损坏）；来源硬阻断",
   example: "terraform force-unlock <lock-id>"}
- {id: iac.terraform-import-unsafe, severity: medium, action: REVIEW,
   match: "terraform import 带来源标记为危险的辅助标志（--allow-missing 等）",
   example: "terraform import --allow-missing aws_db_instance.db db"}
- {id: iac.pulumi-destroy, severity: critical, action: DENY,
   match: "pulumi destroy（尤其带 --yes 跳过确认）",
   example: "pulumi destroy --yes"}
```

## 易绕过模式

来源实现是**字面子串/ERE 匹配**（`grep -qiE`，无分词、无 shell 语义），且 deny glob 多数锚定命令开头。以下写法都能绕过它——也是我们 parser 必须覆盖的及格线：

1. **等效标志与参数顺序**：如 `git push origin main --force`（flag 在 ref 之后）绕过 `git push --force origin main`；`terraform apply --auto-approve=true`、`kubectl delete --filename=x`（来源模式要求 `-f ` 带空格）、`aws s3api delete-bucket` 替代 `aws s3 rb`。→ 我们的 matcher 必须按「可执行文件名 + 子命令 + 归一化 flag 集合」判定，不能按字符串顺序。
2. **等效命令与同义词**：`git branch --delete --force`（= `-D`）、`kubectl delete namespaces`、`mongosh` vs `mongo`、`podman`/`nerdctl` 替代 `docker`、直接 `curl -X DELETE` 打云厂商 API。松软做法是类目级兜底（如 cloud 类目匹配"任意云 CLI 的 delete/terminate/destroy 动词"）→ REVIEW。
3. **shell 引号/转义/拼接**：`terra"form" destroy`、`DROP\ DATABASE`、`ec\rho "safe"` 类字面绕过。→ 匹配前必须做 shell 词法层面的 unquote/解转义/token 重组（在规范化后的 token 流上匹配，而非原始字符串）。
4. **变量与间接执行**：`CMD="terraform destroy"; $CMD`、`eval`、`bash -c '...'`、`echo <base64> | base64 -d | sh`、`xargs sh`、写脚本文件再执行、`make destroy`。guard 只能看到未展开的字面命令（它利用这一点拦 `$VAR` 形态的 shadow URL，是优点；反过来变量也可以藏住整个命令）。→ 至少要做到：识别 eval/bash -c/base64|sh/写入再执行等间接模式并给 REVIEW（"可疑间接执行"启发式规则，与具体类目无关）。
5. **配置外置（来源自己承认的盲区）**：`--shadow-database-url` 若写在 `prisma.config.js` / schema datasource / `.env` 里，`prisma migrate dev` 不带任何危险 flag 照样能打 prod。命令字符串里没有任何可匹配物。→ 这不是 parser 能解决的，需要环境/配置维度的信号（如"当前环境是否含 prod 连接串"），应在架构文档中标注为规则层之外的控制项。
6. **多命令组合**：deny glob 锚定开头的规则可被 `cd x && rm -rf ...` 绕过（它们对部分模式补了 `*...*` 前缀但不全）。→ parser 必须切分 `&&`/`;`/`|`/子shell，对每个子命令独立判定，取最高 verdict。
7. **非 Bash 通道**：整套只挂 Bash matcher；agent 用 Write 工具写 `.sh` 再执行、或用工具内建删除能力即可绕过。→ 我们的 Tool Call 判定不能只看 shell 工具，fs.write / MCP 文件工具的参数也要过规则。
8. **误伤面**：`TRUNCATE`、`kubectl cordon`、`docker system prune -a`、`git reset --hard` 均被它硬阻断；子串匹配还会误伤注释/字符串内容（如 `echo "how to truncate safely"`）。→ 我们按 token 边界 + 三态（改 REVIEW）消化，详见上表标注。

## 可借鉴点 / 不可照抄点

**可借鉴**：

- **事故驱动的规则组织**：每条核心规则都能指到真实事故（terraform destroy 毁 prod、Prisma shadow URL 清库）。建议我们的 YAML 增加 `refs`（事故/来源链接）字段，沉淀"为什么拦"。两个 incident 复盘（`examples/incidents/`）值得引用进我们文档。
- **类目划分骨架基本可直接沿用**：shell / filesystem / database（SQL + ORM 迁移分治）/ cloud（按云厂商再分）/ kubernetes / git / iac，与我们规划的类目高度一致，可作为默认类目表。
- **"可变影子库/reset 型"判定智慧**：ORM 命令在没有 drop 字样时也可能清库（prisma shadow-database、`db push --force-reset`）——这是纯 SQL 关键字匹配漏掉的一整类，必须单列 ORM 规则。
- **fail-closed 与无 bypass 设计**：jq 缺失时脚本直接 block（依赖坏了宁可拦）；不设 agent 可自授权的豁免通道（"能被 agent 说服绕过的 guardrail 等于不存在"）。
- **每条政策附"safe 清单"**（agent 可安全执行的只读操作）：可直接转化为我们的默认 ALLOW 语义文档。

**不可照抄**：

- **匹配机制**：原始字符串 glob + 子串 ERE，无 shell 词法/语法分析，见"易绕过模式"整节。我们的 matcher 要以解析后的命令结构为目标，正则只作兜底。
- **二元判定**：只有 block/allow，无 REVIEW；它硬阻断的若干命令（reset --hard、cordon、helm uninstall、TRUNCATE、migrate 回滚类）在三态模型下应降为 REVIEW。
- **deny glob 前缀锚定不全**：`settings.json` 里同一条目有的带 `*` 前缀有的不带，语义不一致，不能作为我们的匹配规格。
- **实现形态**：每命令串行 fork 6 个 bash+jq 进程、规则硬编码在脚本里改规则要改码发版——与我们"YAML 规则文件即数据"的方向相反，仅作反例参考。

**License 约束**：MIT。规则清单与类目可自由复制/改写进我们的 YAML，只需在规则文件或文档中保留 "Portions adapted from roboticforce/agent-guardrails (MIT, (c) 2026 RoboticForce, Inc.)" 级别的归属声明；无传染性、无商用限制。
