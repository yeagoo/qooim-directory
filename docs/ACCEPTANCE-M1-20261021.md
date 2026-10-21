# M1 验收记录：独立账号收口与搜索增强

日期：2026-10-21。范围见 [2026 Q4 功能规划](FEATURE-PLAN-2026Q4.md) M1。

## 变更

- 新建站点表单只提供独立账号空间；共享账号中心标记 legacy。
- 通过 API 新建共享站点必须显式传 `legacyShared: true`，否则返回 400。
- 迁移 `006-search.sql`：启用 `pg_trgm`，为 publication 标题/说明/SEO 文本建 GIN trigram 索引。
- `Catalog.browse` 使用相关度排序；`%`/`_` 不作为通配符；短查询允许回退。
- 既有共享站、演示 seed 和 CLI 通过显式 legacy 开关保持兼容。

## 验证

```text
pnpm check                 通过
pnpm build                 通过
P0 48/48
P1 88/88
P2 135/135
P3 36/36
P4 28/28
P5 11/11
pnpm test:release          69/69
pnpm test:docker           Docker 整体验收通过
pnpm release:check         通过
pnpm release:check:image   通过
```

Docker 使用 `P1_DOCKER_IMAGE=m1-20261021`；最终应用镜像 `sha256:b710185d...`。日志在 `.local/`。

## 升级注意

- `CREATE EXTENSION pg_trgm` 需要数据库权限或托管服务预装；无权限时迁移会失败并回滚。
- 搜索排序从“rank + slug”改为“相似度 + rank + slug”；原有字面匹配仍保留。
- 旧共享站点继续工作，但不再新增；新站点默认独立账号。
