# toolso 与 Qoo.IM 对照清单

日期：2026-10-23。这是只读调查的结论，用于决定从旧项目 `~/daohang/toolso-ai-open`（下称 toolso）借鉴哪些界面和功能，这一步不改动任何代码。toolso 保持原样，只读不改。

## 权属与许可

- 2026-10-23，维护者（QooIM）确认 toolso 的代码和自有素材都属于本人，其中没有他人的商业素材。toolso 的许可证是 Apache-2.0，可以并入本项目的 AGPL-3.0-only，但需要保留版权声明和 NOTICE。因此 [P0 来源核查](history/P0-SOURCE-AUDIT.md) 中“旧代码全部排除”的结论，对 toolso 不再适用。
- 下面这些仍然**不能带入**：
  - `public/` 下来源不明的图片：`avatar.jpeg`、`tyler.jpeg`、`skeleton-one.png`、`banner.png`、`noise.webp`。它们疑似来自 Aceternity 模板。
  - `public/network-logos/*`（第三方网站 logo）和 `public/scraped/*`（爬取的封面和 logo）。
  - `public/brand/*`：属于 toolso 各站自己的品牌资产，新项目不使用。
  - `simple-icons`：图标本身是 CC0，但图中的品牌受商标规范约束。
- 第三方依赖需要逐项记入 NOTICE：Geist 字体（OFL）、lucide 图标（ISC）、Prism 主题（来源待确认）。

## 两边的技术差异

| | toolso | Qoo.IM |
| --- | --- | --- |
| 页面渲染 | React 19 + Next App Router，62 个页面 | 服务端拼接 HTML 字符串，没有 React，也没有 `.tsx` |
| 样式 | Tailwind 3 + shadcn 风格的 HSL token | 两段手写 CSS（`network.css`、`templates.css`） |
| 模板 | 每个站点在 `registry.ts` 里配置，页面里写死 `site.id` 分支 | 模板 SDK v1（`src/public/sdk.ts`），只有 `directory`、`detail`、`missing` 三种页面 |
| CSP | 宽松 | 严格：`script-src 'self'; style-src 'self'; img-src 'self' data:`，不允许内联样式、CDN 或外链图片 |
| 多站 | 10 个站点写在代码里；用户按站点隔离 | 站点由后台管理，配置有版本，主档与发布分离，可选共享身份；隔离做得更完整 |

**决定移植方式之前要先想清楚这一点**：toolso 的界面主要靠 token 和少量 CSS 类实现，组件本身结构简单，大量 shadcn 组件并没有真正用到。

## 一、界面：建议移植

| 项目 | toolso 来源 | Qoo.IM 现状 | 建议 |
| --- | --- | --- | --- |
| 设计 token | `globals.css`：用品牌色相给中性色染色，再加 `--brand-h`、primary 和 ring | 3 种固定 accent | 移植。站点配置改为可以填色相或颜色 |
| 暗色模式 | next-themes，用 class 切换 | 没有 | 移植。先跟随系统，再加一个切换按钮（通过 `directory.js` 实现，不违反 CSP） |
| 字体与排版 | Geist Sans/Mono，`.type-display/.eyebrow/.num` | 衬线标题 | 移植。字体文件放在本地 `/assets`，并记入 NOTICE |
| 阴影、动效 | `soft/lift/derek` 阴影、expo 缓动、4 种 motion 变体 | 没有 | 移植 token 和 CSS 动画 |
| 卡片聚光、发丝网格背景 | `spotlight.tsx`、`.surface-card`、`background.tsx` | 没有 | 移植，用 CSS 和少量 JS 实现 |
| 导航栏 | `features/navigation/*`：分类下拉、用户菜单、移动端菜单 | 只有简单的 header | 移植 |
| 页头、版块标题 | `page-header.tsx`（面包屑）、`section-header.tsx` | 没有 | 移植 |
| 首页 | Hero（含统计）、精选、分类网格、CTA、FAQ | 首页直接是目录列表 | 移植。需要新增 `home` 页面类型 |
| 工具卡片、列表 | `tool-card`、`tools-list`（分类 chip）、路径式分页 | 卡片只有标题和描述，分页用 `?page=` | 移植 |
| 分类页 | `/category`、`/category/[slug]` | 只能用 `?category=` 筛选，没有独立 URL | 移植。新增路由 |
| 详情页 | hero、侧栏、章节导航、优缺点、FAQ、替代品、相关工具、分享、封面灯箱、阅读进度 | 图片、标题、描述、GitHub 信息、访问和收藏按钮 | 移植布局。有几个区块依赖“二、数据”中的字段 |
| 页脚 | 4 种布局 | 只有 AGPL 源码链接 | 移植 1–2 种，站群友链除外 |
| 语言切换、明暗切换 | `language-switcher`、`mode-toggle` | 只有语言链接 | 移植 |
| 徽章页 | `/badge`、`badge-embed` | 没有 | 和“四、增长”一起做 |
| 后台界面 | 手写的 Tailwind 表格和弹窗，水平和 Qoo.IM 相当 | 原生 JS | 只套用新的 token 统一观感，不重写 |

## 二、数据：要先扩展，否则详情页搭起来也没内容可填

| 字段或概念 | toolso | Qoo.IM | 建议 |
| --- | --- | --- | --- |
| 标签 | `tag` 和 `tool_tag`（多对多，多语言） | 没有（只有 GitHub topics） | 新增 |
| 一个资源属于多个分类 | `tool_category` 多对多 | 每个发布只能有一个分类 | 待定。多分类会影响发布模型和 URL |
| 分类图标和描述 | `icon`、多语言描述 | 只有多语言名称 | 新增 |
| logo、封面 | `logoUrl`、`coverImageUrl` | 每个发布只有一张图 | 新增 logo 字段，封面沿用现有的图 |
| tagline、关键功能、使用场景 | `tool_translation` | 没有 | 新增，可以由 AI 生成 |
| 长文介绍 | Markdown `content` | 没有 | 新增，需要一个安全的 Markdown 渲染器 |
| 定价模式 | `pricingModel` | 没有 | 新增 |
| FAQ | `tool_faq` | 没有 | 新增，用于 FAQPage JSON-LD |
| 发布时间、浏览量 | `publishedAt`、`views` | 视图里没有 | 发布时间直接补；浏览量待定，涉及隐私和写入量 |
| 榜单（热门、编辑精选） | `tool_collection` 及其成员 | 每个发布只有一个 `rank` | 新增，按站点区分 |

## 三、SEO：大多值得移植

| 项目 | toolso | Qoo.IM | 建议 |
| --- | --- | --- | --- |
| JSON-LD | WebSite、Organization、SoftwareApplication、BreadcrumbList、ItemList、FAQPage | 没有 | 移植 |
| og:image、twitter card | 有，详情页 OG 图动态生成 | 没有 | 先输出静态 og:image，动态生成的 OG 图后面再做 |
| hreflang x-default | 有 | 没有 x-default | 补上 |
| sitemap | 按类型拆分，覆盖首页、分类和博客 | 只收录详情页，没有 lastmod，超过 5 万条会出错 | 改成 sitemap index 并补全 |
| RSS | 只有 upperstory 站有 | 没有 | 新增，按站点开关 |
| 替代品页 | 用 pgvector 计算相似，再加 AI 写的一句话对比 | 没有 | 移植，但**不用 pgvector**：固定版本的 postgres 镜像里没有这个扩展，换镜像需要重新签署。改为按同分类、同标签计算，也可以手动指定 |
| 对比页 A vs B | 访问时由 AI 生成，生成后缓存 | 没有 | 移植，接入现有的 AI 任务和对账。建议先生成、人工审核后再发布，不在访问时即时生成 |
| 术语表 | AI 生成 | 没有 | 待定，属于内容营销 |

## 四、增长与运营

| 项目 | toolso | Qoo.IM | 建议 |
| --- | --- | --- | --- |
| 提交时自动抓取网站元数据 | `/api/tools/fetch-metadata` | 投稿只能手填 | 移植，复用现有采集器的 SSRF 防护 |
| 投稿上传图片 | 上传到 R2 | 没有 | 移植，存入现有媒体库 |
| 人机验证 | Turnstile | 有登录限流，没有验证码 | 待定。会引入外部脚本，需要放宽 CSP |
| 用反链换收录，配合徽章 | 投稿状态机、反链校验、定时发布、dofollow 外链 | 没有 | 待定。这是 toolso 的核心增长手段，但会改变审核模型 |
| AI 自动补全资料 | tagline、功能、场景、FAQ、翻译 | 有 AI 任务、提示词版本和对账（M9） | 移植，新增几类提示词 |
| 博客和指南 | MDX 加数据库 | 没有 | 待定 |
| 联系页、隐私条款、使用条款 | 有 | 没有 | 移植，作为简单的静态页面模块 |
| 统计（GA、Clarity、Matomo） | 有 | 没有 | 待定，需要放宽 CSP，也牵涉隐私 |

## 五、Qoo.IM 已有，或做得更完整，不需要搬

多站管理与隔离、配置版本、主档与发布分离、共享身份、Passkey、收藏、投稿审核、采集器（RSS、npm、JSON、GitHub）、AI 用量与对账、定时任务租约、审计、备份恢复、配额，以及许可门禁。

toolso 的 `hot` 采集器会抓取 futurepedia、toolify 等第三方站点，存在版权和服务条款风险，**不移植**。它的“原文和 AI 改写对照审核”做法可以借鉴到现有的候选审核里。

## 六、不搬

train 训练游戏、presets、Cordis 插件市场、插件安全扫描、WordPress、付费收录（aat.ee 外投和 `external_launch`）、站群友链页和 `site-network` 组件、`tool_site_override`（按站改写，后续再考虑）、embedding 向量，以及 messages 里遗留的模板命名空间（testimonials、companies、gridFeatures）。

## 需要维护者决定的问题

1. **技术路线**
   - A（推荐）：在现有模板 SDK 上，用手写 CSS 和字符串模板复刻 toolso 的视觉。不新增依赖，CSP 和模板边界都不受影响，`package.json` 不用改。
   - B：引入 React SSR 和 Tailwind，直接搬 toolso 的组件。和旧代码最接近，但要重写渲染层，依赖会改，镜像需要重新签署，CSP 和模板边界也要重新设计。
2. **数据扩展的范围**：标签、富字段、FAQ、榜单是否一起加？是否支持一个资源属于多个分类？
3. **模板 SDK 怎么扩展**：新增 home、category、tag、alternatives、compare 和静态页等页面类型。可以在 v1 上增量添加（老模板继续可用），也可以升级为 v2。
4. 第三、四部分里标为“待定”的项目，各自要不要做。

## 建议的阶段划分（按路线 A）

| 阶段 | 内容 |
| --- | --- |
| M12 视觉与页面 | 设计 token、暗色模式、字体、导航栏、页头和页脚、首页、卡片和列表、分类路由、详情页布局、JSON-LD、og、x-default、sitemap index。先用现有数据跑起来 |
| M13 内容模型 | 标签、富字段（logo、tagline、功能、场景、定价、长文、FAQ）、榜单，后台表单和 AI 补全 |
| M14 程序化 SEO | 替代品、对比（AI 生成，人工审核），视需要加术语表和 RSS |
| M15 增长 | 投稿元数据抓取、图片上传、徽章，视需要加反链换收录 |

建议在 M12–M15 全部完成、代码冻结之后，再统一签署一次镜像。
