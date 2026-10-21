# 发行前检查清单

日期：2026-10-20。本文是**执行清单**，不是发行批准。每项都要求真实命令输出或人工签署；任何 FAIL 都必须保留，不能改状态文件绕过。

## 0. 当前阻断项

| 项目 | 现状 | 关闭方式 |
| --- | --- | --- |
| 源码包级许可 | **已关闭**：两项 MIT 归属决定已记录，`release:check` 通过 | 无需再处理；如需替换依赖则重新打开 |
| 镜像审查 | **已通过**：六组带保留签署（QooIM，2026-10-21） | 保留项见 `image-review.json` 各组 detail；`next-swc` 无逐 crate 通知的风险已明确接受 |
| 正式品牌 | 名称已定：**Qoo.IM Directory**；域名/仓库名待定 | 定域名、仓库名并清理公开元数据 |
| 真实 OAuth | GitHub/Google 真实授权码交换未做 | 上线前按 [P3 认证操作](P3-AUTH.md) 实测并记录 |
| 容量结论 | 30 站/10 万主档短基线，未认证生产吞吐 | 如有生产承诺，另做独占资源测试；否则明确不承诺 |

`sharp` 已从分发中移除，两个 `sharp-libvips` 包不再计入；不要恢复旧的四项/七组表述。

2026-10-20 已执行一轮本地验收：P0 48/48、P1 84/84、P2 134/134、P3 34/34、P4 28/28、P5 11/11、发行 69/69，Docker 整体验通过。详情见 [本地验收记录](ACCEPTANCE-20261020.md)。这不解锁上述许可、镜像、品牌和真实 OAuth 阻断项。

## 1. 环境预检

```bash
node scripts/preflight.mjs
```

- `FAIL` 必须先修复；当前常见 FAIL 是缺少 `.env`（运行 `pnpm init:env`，再 `chmod 600 .env`）。
- `WARN` 表示不能在此环境完成全部验收，例如没有免密 sudo、OAuth 提供方未配置、发行门禁仍 pending。
- 预检只读，不启动栈、不写 `.env`、不打印密钥。

完整 P0–P5 与 Docker 验收需要：Node 24、pnpm 10.11.1、Docker + Compose、OpenSSL、Python 3、免密 sudo（测试会起独占 PostgreSQL 并修改 `/etc/hosts`）。

## 2. 本地回归

按顺序执行，避免 `pnpm build` 清理 `.next` 与依赖它的测试并发：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test:p0
pnpm test:p1
pnpm test:p2
pnpm test:p3
pnpm test:p4
pnpm test:p5
pnpm test:release
```

- 任何一项非零退出都记 FAIL，不跳过、不并行重跑掩盖。
- 日志统一保存到 `.local/release-acceptance-YYYYMMDD/`。
- `pnpm test:capacity` 是容量短测，不属于功能回归；运行前明确目标。

## 3. 干净 Docker 安装

按 [P1 安装操作](P1-OPERATIONS.md) 和 [P5 运维操作](P5-OPERATIONS.md)：

```bash
pnpm init:env          # 仅首次；已存在时不要覆盖
docker compose -f compose.yaml -f compose.demo.yaml up -d --build
```

验收至少覆盖：

- `/health` 在后台 Host 上返回正常；错误 Host 安全拒绝。
- 空库迁移、三站（atlas/notes/library）、后台登录。
- 共享账号：atlas/notes 共享，library 独立；同一邮箱在 library 需单独注册。
- SMTP 验证邮件、共享登录、退出。
- 内容主档、分类、投稿审核、发布、下架、公开搜索与收藏。
- GitHub 来源同步、候选审核、发布。
- worker 重启后的任务续跑；配置发布与缓存一致性。
- 备份创建、隔离恢复、恢复后登录与内容读取。
- 升级：保留数据卷重建镜像，迁移可重复执行；不删卷、不覆盖 `.env`。

停止演示用 `docker compose down`，保留数据卷；只有明确丢弃演示数据时才用 `down -v`。

## 4. 真实 OAuth（上线前）

1. 建 GitHub OAuth App 与 Google Web Client，回调固定为账号中心 origin：
   - `https://<账号中心>/api/auth/callback/github`
   - `https://<账号中心>/api/auth/callback/google`
2. 凭据只放 `.local/github.json` / `.local/google.json`，权限 0600，不提交、不贴聊天。
3. 先校验再写入：

```bash
pnpm cli auth-provider-check atlas .local/github.json
pnpm cli auth-provider-set atlas .local/github.json
pnpm cli auth-provider-list atlas
```

4. 逐项记录：首次授权、重复登录、拒绝授权、同邮箱已有密码账号、共享站 notes、独立站 library、退出后再次登录。
5. 记录授权码交换结果、回调 URL、测试账号标识（不记 secret）、时间和错误路径。

## 5. 发行门禁

```bash
pnpm release:check
pnpm release:check:image
```

- 当前预期：源码退出 0；镜像退出 0（六组带保留签署）。
- 只有阻断项全部关闭、证据齐全后，才允许两项都退出 0。
- 镜像检查通过也不代表品牌、真实 OAuth、安全审计或容量承诺完成。

## 6. 源码候选与公开仓库

```bash
pnpm build
pnpm exec node scripts/release.mjs export .local/release-candidate-YYYYMMDD
```

检查：

- `SOURCE-MANIFEST.json` 与导出目录逐文件摘要一致。
- `THIRD-PARTY-NOTICES.txt` 含已审查通知，未审查项为 0。
- 不包含 `.local/`、`.env`、数据库备份、OAuth secret、内部绝对路径。
- 公开 Markdown 链接可解析；旧站材料未带入。
- 品牌名、仓库名、LICENSE、README、安装/升级文档一致。
- 完整发布历史中无 secret；公开前另行确认，不在此清单自动推送。

## 7. 证据记录模板

| 检查 | 命令/操作 | 结果 | 日志/截图 | 执行人 | 日期 |
| --- | --- | --- | --- | --- | --- |
| 环境预检 | `node scripts/preflight.mjs` |  |  |  |  |
| 静态检查 | `pnpm check` |  |  |  |  |
| 生产构建 | `pnpm build` |  |  |  |  |
| P0–P5 | 各 `pnpm test:*` |  |  |  |  |
| Docker 安装 | compose up + 手工/自动验收 |  |  |  |  |
| 备份恢复 | 按 P5 操作 |  |  |  |  |
| GitHub OAuth | 浏览器实测 |  |  |  |  |
| Google OAuth | 浏览器实测 |  |  |  |  |
| 源码门禁 | `pnpm release:check` |  |  |  |  |
| 镜像门禁 | `pnpm release:check:image` |  |  |  |  |

## 8. 停止条件

出现以下任一情况，停止发行并保留 FAIL：

- 任一功能回归、构建或 Docker 验收失败。
- 源码或镜像门禁非零，包括“只差一项”。
- 真实 OAuth 未完成，或只有本地受控提供方通过。
- 品牌、公开仓库或发布历史未确认。
- 证据只来自重跑业务测试，没有对应许可/审查材料。

不能用“测试大部分通过”“依赖已移除”“上游还没回复”替代发行批准。
