# Qoo.IM Directory

![CI](https://github.com/yeagoo/qooim-directory/actions/workflows/ci.yml/badge.svg)

Qoo.IM Directory 用一套应用管理多个独立导航站：一个后台管理多个品牌站点，共享资源主档，各站独立发布。当前版本为 `v0.2.0-rc.4`（预发布，可自托管试运行）。已实现：多站点与后台权限、版本化主档与各站发布、多语言目录与搜索、投稿审核与附图、收藏、媒体库、toolso/basic/editorial 模板、程序化 SEO、AI 生成/翻译/富字段补全、站点 persona 与统一分发、GitHub/RSS/npm/JSON 采集、Passkey、备份恢复和源码归档。稳定版 `v0.2.0` 仍需真实 OAuth、AI 提供方、RSS/npm 源和 Passkey 设备的外部验收。项目历史与当前状态见[项目历史总览](docs/PROJECT-HISTORY.md)。

- [发行边界与依赖 Review](docs/history/RELEASE-REVIEW.md)
- [P5 运行与发行准备](docs/history/P5-FINAL.md) · [备份恢复与源码操作](docs/P5-OPERATIONS.md)
- [P4 交付与 Review](docs/history/P4-FINAL.md) · [GitHub 项目操作](docs/P4-GITHUB.md)
- [P3 交付与待联调项](docs/history/P3-FINAL.md) · [认证操作](docs/P3-AUTH.md) · [模板开发](docs/TEMPLATE-DEVELOPMENT.md)
- [P2 交付与 Review](docs/history/P2-FINAL.md) · [内容操作](docs/P2-CONTENT.md)
- [P1 交付与 Review](docs/history/P1-FINAL.md)
- [安装和操作](docs/P1-OPERATIONS.md) · [后台任务 Review](docs/history/WORKER-REVIEW.md)
- [开发方案](docs/DEVELOPMENT-PLAN.md) · [文档索引](docs/README.md) · [生产部署](docs/DEPLOY-PRODUCTION.md)

新实现未迁入旧项目平台源码。许可证为 [AGPL-3.0-only](LICENSE)，正式品牌为 Qoo.IM Directory（域名和公开仓库名待定）；包保持 private，避免误发布 npm。构建会生成本部署对应源码下载包，页面提供获取入口。

## 本地运行

需要 Node 24、pnpm 10.11.1、Docker Compose：

```bash
pnpm install --frozen-lockfile
pnpm init:env
docker compose -f compose.yaml -f compose.demo.yaml up -d --build
```

访问 `https://admin.localhost:8443/admin`，凭据在本机生成的 `.env`。演示采用本地 CA，浏览器信任步骤见[操作文档](docs/P1-OPERATIONS.md)。三个示例域名为 `atlas.localhost`、`notes.localhost`、`library.localhost`，同用 HTTPS 8443；前两站共享账号，第三站独立。

后台支持建站、成员授权、配置流程、资源主档、站点发布、分类与投稿审核。公开目录支持搜索、详情及按站收藏投稿。新域名的 DNS/TLS/代理由部署者配置。

## 验证

```bash
pnpm exec playwright install chromium firefox webkit
pnpm check
pnpm build
pnpm test:p0
pnpm test:p1
pnpm test:p2
pnpm test:p3
pnpm test:p4
pnpm test:p5
pnpm test:p6
pnpm test:p7
pnpm test:p8
pnpm test:p9
pnpm test:p10
pnpm test:p11
pnpm test:p12
pnpm test:p13
pnpm test:p14
pnpm test:p15
pnpm test:p16
pnpm test:p17
pnpm test:p20
pnpm test:release
pnpm test:capacity
pnpm template:preview
pnpm test:docker
```

测试还需要 OpenSSL、Python 3，以及能非交互调用 Docker 和管理测试 hosts 条目的 sudo 权限。测试创建并检查独占 PostgreSQL 数据库，只清理自己的资源。不要手动设置 P0_DATABASE_URL 指向已有库。建议顺序运行浏览器和 Docker 验收，避免网络接口变动打断浏览器导航。

正常演示停止不删除数据卷；`down -v` 只用于明确要丢弃的演示数据。服务端保持 TLS 校验，浏览器仅在一次性测试上下文中忽略测试证书错误。
