# 2026 Q4 功能规划与 Review

日期：2026-10-21。本文是规划，不是已实现功能。方向已定：**新站点使用独立账号体系，不再打通跨站身份**；共享账号中心保留为既有部署兼容，不再新增迁移/静默 SSO 能力。

## 实施状态（2026-10-21）

- M5 已完成代码：RSS/npm/通用 JSON 采集器、统一候选审核、接受只建草稿；P4 30/30 通过，详见 [M5 验收](ACCEPTANCE-M5-20261021.md)。GitHub 专用同步保留，未做 full adapter 迁移。尚未发布。
- M4 已完成代码：站点级 AI 配置/异步任务/预算/SSRF 防护、后台设置和内容页人工确认；P2 137、P3 39 通过，详见 [M4 验收](ACCEPTANCE-M4-20261021.md)。尚未发布。
- M3 已完成代码：站点媒体库、图片发布渲染、公开访问门控、后台媒体页、加密媒体备份/恢复；P2 136、P3 38、P5 11 通过，详见 [M3 验收](ACCEPTANCE-M3-20261021.md)。尚未发布。
- M2 已完成代码：`@better-auth/passkey@1.7.10`、站点级 RP ID、账号页添加/删除、登录页 Passkey 登录；P3 37/37 通过，详见 [M2 验收](ACCEPTANCE-M2-20261021.md)。尚未发布。
- M1 已完成代码：新建站点表单只提供独立账号；API 新共享站点必须显式 `legacyShared: true`；共享中心标记 legacy；搜索迁移 `006-search.sql` 与 `pg_trgm` 相关度查询已实现。
- 搜索测试：P1 88/88、P2 135/135 通过。
- 尚未发布：M1 变更未进入 `v0.1.0` tag，发布前需重新跑全量回归和镜像 evidence。

## 一、范围与原则

### 已确认决策

- 新站点默认独立账号空间，每站自己的读者、会话、Passkey、媒体和 AI 配额。
- 不再开发“已有独立账号迁移/冲突解决”和“跨域静默 SSO”；现有共享站不强制迁移。
- 账号中心相关旧代码保留，但标记为 legacy，不再作为新功能前置。
- `配置自动三方合并/数组语义合并` 与本批无关，继续不做。

### 新功能共同原则

1. **站点作用域**：所有表、API、配额、审计都带 `site_id`，不引入跨站默认共享。
2. **人工审核优先**：AI 生成、采集内容只能进入草稿/候选，不能自动发布。
3. **不抓屏、不猜接口**：采集只接官方 API、RSS/Atom 或用户提供的结构化源；不写网页爬虫。
4. **许可和镜像门禁一起走**：新增依赖先取证，再改锁文件；需要时重做源码通知和六组镜像 evidence。
5. **默认关闭**：AI/采集/媒体通过站点功能开关启用；Passkey 可在站点配置开启。
6. **可恢复**：任何新增持久化数据都必须进入备份/恢复与删除清理路径。

## 二、五项功能规划

### A. Passkey（不做 MFA）

**目标**：每站读者可以用 Passkey 注册/登录，密码仍可作为回退；不引入第二因素、不改现有会话模型。

**范围**

- 使用 `@better-auth/passkey@1.7.10`（与 better-auth 1.7.10 对齐；MIT）。
- 站点级 RP ID = 站点 hostname；origin 必须精确匹配；仅 HTTPS（localhost 开发例外）。
- 账号页/登录页支持：添加 Passkey、命名、删除、Passkey 登录。
- 一个用户可绑定多个 Passkey；删除最后一个登录方式被拒绝；密码回退保留。
- 不做：MFA、跨站 Passkey、管理员代注册、设备同步策略承诺。

**数据/接口**

- 由插件建表（`passkey` challenge/credential）；现有 `auth_instance` 表前缀隔离，不跨站。
- 新增站点开关 `passkey_enabled`（站点配置或 auth 配置）。
- `/account` 增加 Passkey 区块；登录页增加“使用 Passkey”入口。
- 失败路径：不支持 WebAuthn、用户取消、origin/RP 不匹配、challenge 过期、凭据已撤销。

**测试**

- Chromium CDP 虚拟认证器：注册 → 登出 → Passkey 登录 → 删除 → 不能再登录。
- 错误 origin/rpId、重复 challenge、已删除凭据、最后一个登录方式保护。
- Playwright 浏览器回归 + 无 Passkey 环境回退密码。

**依赖/许可**：`@better-auth/passkey`、`@simplewebauthn/server`、`@simplewebauthn/browser`（均 MIT）需要通知与镜像 evidence 更新。

**估算**：5–8 人日。

---

### B. 搜索能力增强

**目标**：把当前 `strpos(lower(title||description))` 的子串搜索升级为有索引、可排序、可高亮的多语言站内搜索。

**范围**

- PostgreSQL `pg_trgm`：对 `publication` 的标题/描述/SEO 文本建 GIN trigram 索引；中文按字符 trigram，英文按词/字符混合。
- 查询：关键词、locale、分类、排序（相关度/最新/rank）、分页；只搜 published + public。
- 相关度：标题精确 > 标题相似度 > 描述相似度 > rank；长度 <3 的查询回退 `ILIKE`。
- UI：搜索框、结果高亮、空结果建议、URL 参数可分享。
- 不做：外部搜索引擎、向量检索、搜索日志/分析、同义词管理。

**数据/接口**

- 迁移启用 `CREATE EXTENSION IF NOT EXISTS pg_trgm`，创建表达式 GIN 索引；不新增业务表。
- `Catalog.browse` 改为参数化查询；`/api/search` 保持响应结构兼容。
- 管理端加“重建搜索索引”CLI/说明（索引自动维护时通常不需要）。

**测试/验收**

- 10 万 publication 数据下 p95 < 200ms（目标，不是生产承诺）。
- 中文 1–2 字、英文短语、大小写、特殊字符、空查询、超长查询。
- 未发布/下架/私有内容不出现；分页稳定；分类过滤。
- EXPLAIN 确认使用 trigram 索引（短查询允许回退）。

**依赖**：PostgreSQL 官方镜像含 `pg_trgm`；托管数据库需确认扩展可用。

**估算**：3–5 人日。

---

### C. 媒体/图片管理

**目标**：后台可上传、选择、复用图片，资源主档/模板可引用；不引入不受控的文件系统路径。

**范围**

- 站点级媒体库：上传 JPEG/PNG/WebP（拒绝 SVG/GIF/可执行内容），最大 10MB，单站配额。
- 文件按内容哈希存储（本地卷 `data/media/<site>/<sha>`），数据库只存元数据；后续可换 S3 兼容存储。
- 资源主档增加可选 `image` 引用（媒体 ID + alt）；模板 SDK 输出公开 URL。
- 后台：上传、预览、alt 必填、选择器、删除（仅未被引用）；孤儿清理任务。
- 公开服务：`/media/:id` 只允许已发布引用；ETag/缓存；`Content-Disposition: inline`；严格 MIME/CSP。
- **不做服务端缩放/裁剪**：避免重新引入 `sharp`/libvips 许可和原生依赖。首版保存原图，浏览器用 `srcset`/CSS 控制尺寸；若以后必须转码，单独做许可评估。
- 备份必须包含媒体文件：当前 `backup.mjs` 只备份 PostgreSQL，需扩展为“数据库 + 媒体归档 + 清单”，恢复时一起校验。

**数据/接口**

```sql
media(
  id uuid primary key, site_id text not null, sha256 text not null,
  mime text not null, bytes bigint not null, width int, height int,
  alt text not null default '', created_by uuid, created_at timestamptz,
  status text not null default 'active', unique(site_id, sha256)
)
```

- `POST /admin/api/media`（multipart）、`GET /admin/api/media`、`DELETE /admin/api/media/:id`。
- 资源 `resourceData.image` 可选 `{ mediaId, alt }`；发布快照存公开 URL。
- 上传校验：魔数 + 扩展名 + `image-size`/自写头解析；像素上限；拒绝 polyglot/SVG。

**测试**

- MIME 欺骗、SVG、超大像素、超配额、路径穿越、未发布媒体泄漏、引用删除保护、孤儿清理。
- 备份/恢复后媒体 URL 仍可访问；删除站点时清理。
- 浏览器上传 + 选择 + 发布后公开访问。

**依赖/许可**：若用 `image-size`（MIT）需取证；或自写 PNG/JPEG/WebP 头解析，零依赖。**不要恢复 sharp**，除非重新做 libvips 证据。

**估算**：8–12 人日（含备份扩展）。

---

### D. 内置 AI 生成/翻译

**目标**：在内容草稿中生成标题/描述/SEO，或把 zh/en 内容互译；输出必须人工确认，不能自动发布。

**范围**

- 站点级 AI 配置：OpenAI-compatible HTTPS endpoint、model、API key（加密存储）、启用开关、月度 token 预算。
- 操作：
  - 根据已有标题/描述/URL/关键词生成或改写描述；
  - 生成 SEO title/description；
  - zh↔en 翻译；
  - 生成结果以 diff 形式展示，接受后写入草稿，仍需正常发布。
- 异步 worker 任务：超时、重试、取消、配额、失败审计；不阻塞请求。
- 提示词模板版本化；记录 provider/model/prompt version/token 用量/操作者；不记录 API key。
- 安全：服务端调用（key 不下发浏览器）；端点 HTTPS + 私网 SSRF 防护；输入长度限制；输出 schema 校验；提示注入不启用工具调用；不自动抓取 URL。
- 不做：自动发布、自动改已发布内容、网页爬取总结、图片生成、向量知识库。

**数据/接口**

```sql
ai_provider(site_id, endpoint, model, sealed_key, enabled, monthly_tokens, ...)
ai_job(id, site_id, actor_id, kind, input jsonb, output jsonb, status, tokens, error_code, ...)
```

- `POST /admin/api/ai/generate`、`/translate`；`GET /admin/api/ai/jobs/:id`。
- 后台内容编辑器加“AI 生成/翻译”按钮与 diff；人工接受才写主档。
- 配额按站点/月；超限返回明确错误；预算可配置为 0 关闭。

**测试**

- 假 OpenAI-compatible HTTPS fixture：成功、超时、429、5xx、无效 JSON、超长输出。
- 不接受自动写主档；人工接受后版本/审计正确。
- key 不明文返回/落日志；SSRF 拒绝私网/非 HTTPS；配额与并发限制。
- 翻译保留 URL、长度约束、缺失字段处理。

**依赖/许可**：首版可用原生 `fetch`，不引入 SDK；若引入 SDK 需取证。AI provider 的 ToS/数据出境由部署者确认。

**估算**：8–12 人日。

---

### E. 更多垂直采集模块

**目标**：把当前只支持 GitHub 的来源扩展为可插拔采集器；每种来源只走官方 API/RSS，不写网页爬虫。

**范围（首批）**

1. **RSS/Atom**：博客、新闻、播客文字摘要；ETag/Last-Modified、去重、内容审核。
2. **npm registry**：按 keyword/scope 采集包元数据；官方 registry API；许可证/维护状态字段。
3. **通用 JSON 源**（可选）：管理员配置 URL + JSONPath 映射 + 字段 schema；严格大小/超时/HTTPS/私网限制，不作为爬虫。
- 暂不做：YouTube/Product Hunt/社交平台（配额、ToS、密钥复杂度高），需要单独评估。
- 不做：网页 HTML 抓取、登录后数据、绕过 robots/付费墙。

**架构**

- 把 `github_source/github_candidate/github_task` 泛化为：
  - `source(id, site_id, resource_id, kind, sealed_config, enabled, interval, version, etag, last_hash, remote_id, next_run_at)`
  - `source_candidate(... data jsonb ...)`
  - `source_task(... kind ...)`
- 定义 adapter 接口：`validateConfig`、`fetch(cursor/etag)`、`normalize`、`contentHash`、`statsFields`、`reviewFields`；GitHub 作为第一个 adapter 迁移。
- 统计字段自动更新、内容字段人工审核的规则复用 GitHub 现有语义。
- UI：按 kind 新建来源、字段映射（通用 JSON）、候选审核、任务状态。

**安全**

- 仅 HTTPS；DNS 解析后拒绝私网/环回/链路本地；禁止重定向到私网；响应上限 2MB；超时 10s。
- 采集配置加密；错误日志不记录 URL 凭据/token。
- 速率限制与每站配额；失败退避。

**测试**

- RSS fixture（合法/畸形/超大/304）、npm fixture、通用 JSON fixture。
- 去重、候选内容/统计分离、字段审核、限流、SSRF、重定向、超时。
- 10 万条候选的清理/保留策略。

**依赖/许可**：`fast-xml-parser`（MIT）如用于 RSS，需要通知；或自写受限解析器。GitHub adapter 迁移不改外部行为。

**估算**：10–15 人日。

## 三、建议顺序与里程碑

不建议五项并行；每项都改 schema/安全边界，且需要独立回归。

| 里程碑 | 内容 | 估算 | 退出条件 |
| --- | --- | --- | --- |
| M1 | 独立账号收口 + 搜索增强 | 1 周 | 新站不再创建共享中心；搜索索引/性能测试通过 |
| M2 | Passkey | 1–1.5 周 | 虚拟认证器端到端；最后登录方式保护 |
| M3 | 媒体库 + 备份扩展 | 2 周 | 上传/引用/公开/删除/恢复全链路 |
| M4 | AI 生成/翻译 | 2 周 | 假 provider、人工确认、配额与密钥保护 |
| M5 | 采集器泛化 + RSS/npm | 2–3 周 | GitHub 行为不变；新 adapter 审核链路通过 |

总计约 **8–10 周**（单人；不含真实 provider 联调、法律意见和镜像复审）。可并行的是前端/文档，不建议并行迁移。

## 四、Review：我会调整或拒绝的部分

### 同意的方向

- 独立账号是合理简化：去掉跨站迁移、静默 SSO 和共享空间的长期维护成本。
- 五项功能都应在站点作用域内做，不能借 AI/媒体/采集重新引入跨站耦合。

### 必须调整

1. **不要删除共享代码**：现有部署可能已用共享中心；先标记 legacy、停止新功能依赖，等迁移方案明确再删。直接删会造成不可逆升级风险。
2. **不要为了 Passkey 升级整个 Better Auth 大版本**：用 `@better-auth/passkey@1.7.10` 对齐现有 1.7.10；升级需重新做认证回归、依赖许可和镜像 evidence。
3. **媒体不要恢复 sharp**：当前 `sharp` 是为移除 libvips 许可而删的；媒体首版不做服务端转码。若产品必须裁剪/压缩，应先做图像库许可评估，再改依赖。
4. **AI 不要做“输入 URL 自动总结”**：会同时引入 SSRF、抓取合规和提示注入；首版只基于已有内容/管理员 brief。
5. **采集不要写爬虫**：RSS/官方 API/通用 JSON 足够验证垂直能力；网页抓取需要单独的法律与稳定性评估。
6. **搜索不要上外部引擎**：`pg_trgm` + 现有 PostgreSQL 足够；引入 Meilisearch/Typesense 会增加运维、备份和新许可。
7. **媒体备份是隐藏的大项**：只做上传不做备份扩展，会在灾难恢复时丢图；M3 必须把媒体归档纳入 `backup.mjs`。

### 风险登记

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 新依赖许可/镜像 evidence | 发行门禁失败 | 每个里程碑先取证再改锁文件 |
| WebAuthn origin/RP 配置错误 | 登录不可用或跨站风险 | 站点级 RP ID + 精确 origin 测试 |
| 上传文件解析漏洞 | RCE/XSS/存储耗尽 | 魔数/尺寸/配额、拒绝 SVG、独立媒体域或严格 CSP |
| AI 提示注入/数据出境 | 内容污染/合规 | 无工具调用、输入限制、部署者确认 provider ToS |
| 采集 SSRF | 内网探测 | HTTPS、DNS/IP 校验、禁私网重定向、响应上限 |
| 搜索索引膨胀/慢查询 | 公开页延迟 | GIN + 查询上限 + EXPLAIN/10万数据测试 |
| 媒体卷未备份 | 灾难恢复丢数据 | 备份 manifest 包含媒体哈希/归档 |

## 五、验收与发行边界

每个里程碑都必须：

- 新增依赖完成 `third-party` 通知/来源；必要时重做镜像 evidence 并由审查人确认。
- 新增表/列有迁移、回滚/恢复验证；媒体加入备份。
- 新增管理 API 有权限、CSRF/Origin、审计。
- 新增公开输入有长度/速率/SSRF/文件类型限制。
- 回归 P0–P5、发行测试、Docker；不把“功能测试通过”写成真实 provider 或生产容量已验收。
- 更新 `docs/` 操作文档和 `CHANGELOG.md`。

## 六、建议的第一个动作

先做 **M1 的独立账号收口**：把新站创建/编辑中的共享中心选项隐藏或标记 legacy，新增配置默认独立；不删旧代码。搜索增强可作为同一里程碑的低风险项。完成后再开 Passkey。
