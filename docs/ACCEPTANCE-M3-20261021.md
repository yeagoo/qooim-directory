# M3 验收记录：媒体/图片管理与备份扩展

日期：2026-10-21。范围见 [2026 Q4 功能规划](FEATURE-PLAN-2026Q4.md) M3。

## 变更

- 迁移 `007-media.sql`：新增站点级 `media` 表、`publication.image`，重建 `public_listing` 输出公开图片 URL/alt。
- 上传 JPEG/PNG/WebP（≤10 MiB），按魔数/尺寸校验，拒绝 SVG/GIF/MIME 欺骗；按站点 + SHA-256 去重。
- 资源草稿 `overrides.image` 引用媒体；发布时校验本站归属，公开图片只在 `public_listing` 可见时提供。
- 后台站点页新增“媒体库”：上传、预览、alt、复制引用 JSON、删除引用保护。
- 模板 SDK/详情/列表渲染图片和 `og:image`；公开图片内容哈希 ETag、长缓存。
- 备份增加 `media.tar.enc`：独立 AES-256-GCM、文件数/字节/明文摘要；恢复要求空媒体目录并校验。
- Compose 使用 `MEDIA_HOST_PATH` 绑定到 `/app/data/media`；未恢复 `sharp`。

## 验证

```text
pnpm check                 通过
pnpm build                 通过
P0 48/48
P1 88/88
P2 136/136
P3 38/38（含后台媒体库浏览器上传）
P4 28/28
P5 11/11（含加密媒体归档恢复）
pnpm test:release          69/69
pnpm test:docker           Docker 整体验收通过
pnpm release:check         通过
pnpm release:check:image   通过
```

Docker 使用 `P1_DOCKER_IMAGE=m3-final-20261021`；最终应用镜像 `sha256:5aa0e49a...`。Docker 验收覆盖空库、三站、共享登录、内容/配置/任务恢复，未在 Docker 内做真实媒体上传；媒体链路由 P2/P3/P5 覆盖。

## 升级注意

- 迁移会重建 `public_listing`；升级期间停止 web/worker，避免旧代码读取旧视图。
- Compose 部署需创建可写的 `MEDIA_HOST_PATH`（默认 `./data/media`），并把它加入备份；不要只备份 PostgreSQL。
- 备份恢复的媒体目录必须为空；旧备份没有 `media.tar.enc` 时仍可恢复，但不会恢复媒体。
- 仍不做服务端缩放/裁剪、对象存储、CDN 或恶意图片解码沙箱；只做头部校验，不能承诺解码器安全。

## 安全边界

- 公开图片以内容哈希标识；未发布/下架/跨站/分类不可用返回 404。
- 删除检查线上和草稿引用，引用中返回 409。
- 上传/列表/删除需要后台账号和站点权限；删除要求 Origin。
- 媒体 tar 拒绝符号链接；恢复校验认证标签、明文摘要、文件数/字节。
