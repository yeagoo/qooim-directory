# 媒体/图片管理

状态：M3 已实现，M6 加入站点配额与孤儿文件清理。站点级媒体库，不做跨站共享；不引入 `sharp`/libvips。

## 存储与限额

| 项 | 约束 |
| --- | --- |
| 类型 | JPEG、PNG、WebP；拒绝 SVG/GIF/可执行内容 |
| 大小 | 单文件 ≤ 10 MiB；请求 ≤ 15 MiB（base64 后） |
| 尺寸 | 宽高 ≥1、≤12000；总像素 ≤4000 万 |
| 去重 | 每站按 SHA-256 唯一；同图复用已有记录 |
| 路径 | `MEDIA_ROOT/<site_id>/<sha256>.<ext>`，默认 `.local/media` |
| 配额 | 默认每站 1 GiB / 5000 个文件，可在后台“配额”页或 `site-limit-set` 调整（M6）；列表最多返回 200 张 |

浏览器上传使用 JSON + base64，避免 multipart 解析器；服务端只信任魔数和尺寸解析，不按扩展名或客户端 MIME 放行。文件名只用于展示并做 HTML 转义。

## 数据与 API

`media` 表保存 `site_id`、文件名、MIME、字节数、宽高、SHA-256、alt、创建者和时间。资源草稿引用：

```json
{
  "overrides": {
    "image": { "mediaId": "<uuid>", "alt": "封面说明" }
  }
}
```

| 方法/路径 | 用途 |
| --- | --- |
| `GET /admin/api/media?site=<id>` | 列出本站媒体 |
| `POST /admin/api/media` | 上传 `{site,filename,mime,alt,data(base64)}` |
| `GET /admin/api/media/usage?site=<id>` | 已用字节/文件数与配额（M6） |
| `GET /admin/api/media/<id>/file` | 管理员预览（登录+站点权限） |
| `DELETE /admin/api/media/<id>` | 删除；需 Origin，引用中返回 409 |
| `GET /media/<id>` | 公开原图；仅被 `public_listing` 引用时 200 |

发布时 `Content.material` 校验媒体属于本站；`publication.image` 保存 `{mediaId,alt}`，视图输出 `/media/<id>`。公开图片有内容哈希 ETag 和 `public, max-age=31536000, immutable`；未发布/下架/分类不可用/跨站均 404。

## 管理 UI

后台站点页 → “媒体库”（`#media/<site>`）：上传、alt 必填、预览、复制引用 JSON、删除。删除前会检查线上和草稿引用，不提供强制覆盖。

## 备份

媒体文件不在 PostgreSQL 内，必须与数据库一起备份。`scripts/backup.mjs` 增加可选媒体目录参数：

```bash
node --env-file=.env --env-file=.local/backup.env \
  scripts/backup.mjs create navigation-network-db-1 network network \
  .local/backup-2026-10-21 ./data/media
```

备份目录新增 `media.tar.enc`（独立 AES-256-GCM 认证，记录文件数/字节/明文摘要）；恢复：

```bash
node --env-file=.env --env-file=.local/backup.env \
  scripts/backup.mjs restore isolated-db network_restore network \
  .local/backup-2026-10-21 ./data/media-restored
```

目标媒体目录必须为空；备份拒绝符号链接，恢复后校验文件数/字节。没有媒体目录参数的旧备份仍可恢复，但不会恢复媒体。Compose 默认把 `MEDIA_HOST_PATH`（默认 `./data/media`）挂到 `/app/data/media`；生产需确保 UID 1000 可写。

## 配额与孤儿清理（M6）

- 上传在站点级 advisory lock 内完成“去重 → 配额检查 → 写文件 → 写记录”，并发上传不会超出配额。同站同图复用已有记录，不占配额；超限返回 413，消息里写明上限。调低配额只阻止新上传，不删已有文件。删除也走同一把锁。
- Worker 每小时运行一次孤儿清理（见 [P5 运维](P5-OPERATIONS.md#保留期与配额)）：
  - 删除超过 60 分钟的 `.tmp-*` 临时文件；
  - 删除超过 60 分钟、且数据库里没有同站同哈希同类型记录的图片文件；
  - 不跟随符号链接，不删除无法识别的文件名；
  - 数据库有记录但文件缺失的，只计入 `missingFiles`，不删除记录；
  - 每次最多扫描 1 万个文件。
- 不会自动删除“已登记但未被引用”的媒体：这些是运营者主动上传的内容。

## 未做

- 服务端缩放/裁剪/转码、AVIF、动图。
- 对象存储/S3、CDN 签名 URL。
- 媒体替换、版本历史、批量上传（M8，见 [M6–M10 方案](FEATURE-PLAN-M6-M10.md)）。
- 真实恶意图片解码器/浏览器兼容性矩阵；当前只做头部校验，不承诺解码安全性。

## 验收

P2 覆盖上传、尺寸/类型校验、草稿发布、公开/跨站/未发布访问、引用删除保护；P3 覆盖后台媒体库浏览器上传；P5 覆盖加密媒体归档与恢复。详见 [M3 验收](ACCEPTANCE-M3-20261021.md)。
