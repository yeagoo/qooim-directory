# 模板 SDK 与 AI 开发

P3 提供 API v1，以及 `basic` 精选目录、`editorial` 编辑手记两个可部署模板。后者是本项目由 AI 编写、经实现者 Review 和测试的例子，不代表任意 AI 输出都能直接上线。

## 边界

模板是与应用一起部署的可信代码，SDK 和静态依赖检查不是安全沙箱。AI 生成的模板上线前必须经人工审查；不能把“检查通过”等同于代码可信。站点编辑者只选择已安装模板和填写参数，不能通过配置上传、执行代码。

唯一公开入口为 `src/public/sdk.ts`。模板接收已过滤的 DTO，不接收数据库连接、环境变量、密钥、用户会话或内部备注。列表、详情、分类计数及语言链接由公共数据层先计算；模板不能自行放宽可见性。

`pnpm check` 递归检查模板及 SDK 的静态导入，拒绝服务端/数据库依赖、未许可包、`process`、`globalThis`、`require`、动态导入、`eval` 和 `Function`。这是架构门禁；它不覆盖所有 JavaScript 绕过方式，不能安全运行恶意代码。

## 开发流程

1. 从 `src/templates/basic.ts` 或 `editorial.ts` 复制结构，导出 `defineTemplate({id, apiVersion:1, render})`；文本和属性值使用 `escapeHtml`，不要拼接未转义内容。
2. 支持 `directory`、`detail`、`missing` 三种页面；保留空结果、搜索/分类/分页、收藏、语言链接、canonical/hreflang 和 noindex。使用 SDK 的 `frame`、`metadata` 等可复用函数。
3. 在 `src/server/templates.ts` 注册实现，在 `src/templates/manifest.ts` 声明 ID/名称/版本及 CSS。新增模板需要构建部署。
4. 运行下面的夹具预览、架构检查和测试；检查手机、桌面、键盘操作、空列表、缺译页以及长文本。人工审查后再部署，通过后台草稿选择模板，预览并发布。

```bash
pnpm template:preview
pnpm check
pnpm test:p3
pnpm build
```

预览脚本生成 `.local/template-preview/` 下 8 个独立 HTML：两个模板各自的列表、详情、缺译和空结果页。可直接本地打开；预览仅使用 `fixtures/templates/directory.ts`，无需数据库、真实账号或生产数据。预览不执行收藏/登录脚本，链接不模拟后端接口。

运行时会克隆并冻结 DTO，再调用模板；参数拒绝未知字段，不兼容 API 或未注册模板不能渲染/发布。API v1 是此项目当前约定，还不是可独立安装的 npm 包或跨版本兼容承诺。

## 参数

两个模板共用严格参数 Schema：

| 参数 | 值与省略行为 |
| --- | --- |
| accent | forest（显示默认）、indigo、terracotta |
| density | comfortable（显示默认）、compact |
| eyebrow | 最长 100 字；省略使用模板内置文案 |
| footer | 最长 300 字；省略使用 SDK 页脚 |

完整快照示例片段：

```json
{"template":"editorial","templateParams":{"accent":"terracotta","density":"comfortable","eyebrow":"THE READING ROOM"}}
```

上述片段放在配置的 `config` 中，不是完整导入文件。省略 `templateParams` 规范化为 `{}`；省略某个参数使用显示默认值，不保留旧快照中的该字段。后台基础表单可选择模板，参数可在完整配置 JSON 编辑，也可导出后交给 AI 修改、校验并导入。模板选择属于配置发布；模板源码变化属于代码部署。

## 可交给 AI 的任务

> 请阅读 src/public/sdk.ts、src/templates/basic.ts 和 fixtures/templates/directory.ts，编写 API v1 导航模板。只从公开 SDK 导入，不访问数据库、环境、认证或网络。支持列表、详情、缺译与空列表，保留搜索、分类、分页、收藏和 SEO。所有动态文本必须转义。样式响应式且尊重键盘焦点。给出模板、注册项和 CSS 的实际修改，运行预览与检查。提交供人工审查，不能自动上线。

AI 也可只改模板参数或导航配置；这种场景无需生成新代码，仍按草稿、比较、预览、发布流程执行。


P4 在 API v1 DTO 中增加可选 `project` 元数据；内置模板显示批准发布时的 Stars、语言、许可证与归档状态。原模板可忽略该可选字段，不能自行请求 GitHub 刷新内容；定义见 SDK 的 `PublicProject`。

## 部署源码获取

P5 在模板服务端出口追加 `/source.tar.gz` 获取入口，构建时生成对应源码归档。保留该入口；自定义模板可以使用 SDK frame，也兼容 HTML 结束标签大写或省略的输出。原始离线夹具预览不经过部署出口。运行和许可边界见 [P5 运维](P5-OPERATIONS.md)。

## M12：React 模板、首页与 toolso 模板

M12 在 API v1 上做了只增不改的扩展，`basic` 和 `editorial` 不受影响。

- **React 输出**：`render` 可以返回完整 HTML 字符串，也可以返回 React 元素。返回 React 元素时，服务端用 `react-dom/server` 的 `renderToStaticMarkup` 渲染一次，浏览器端没有 hydration。
  - 在 Next 构建里，`react` 解析到的是 react-server 版本，其中没有 hooks 和 context；`react-dom/server` 也不能被打包进路由，所以由 Node 在运行时加载。
  - 因此模板里不能使用 `useState`、`useContext` 等 hooks，也不能写异步组件。`pnpm check` 只允许从 `react` 导入类型和 `Fragment`、`Children`、`cloneElement`、`isValidElement`、`forwardRef`、`createElement`。
- **首页**：模板提供 `renderHome(page: TemplateHomePage)` 后，`/` 和 `/<locale>` 会渲染首页，页面数据包括精选条目、分类和总数。没有提供 `renderHome` 的模板，`/` 仍是默认语言的目录页，`/<locale>` 返回 404。
- **分类页**：`/<locale>/<catalogPath>/category/<id>` 渲染目录页，同时传入 `categoryPage`。这个地址会被索引，`?category=` 筛选结果页仍是 noindex。分类不存在时返回 404。
- **详情页附加数据**：详情页额外传入 `categories`，以及最多 6 个同分类条目 `related`。
- **新参数**：`accentColor`（`#RRGGBB`）和 `motion`（`smooth`、`crisp`、`playful`、`minimal`）。`accentColor` 由 `/assets/theme/<hex>.css` 转换成色板变量，模板不需要写内联样式。
- **允许的包**：模板目录下只额外允许 `lucide-react`、`clsx`、`tailwind-merge`。

### toolso 模板

`src/templates/toolso/` 移植自旧项目 toolso-ai-open，来源和许可证见目录下的 `NOTICE.md`。

| 部分 | 位置 |
| --- | --- |
| 样式 | `styles.css` 加 `tailwind.toolso.config.cjs`，由 `pnpm build:css` 编译为 `src/ui/generated/toolso.css` 并提交；`pnpm check` 会检查它是否最新 |
| 组件 | `components/`；页面在 `pages/`，入口和页面外壳在 `document.tsx` |
| Next 与 React 兼容层 | `shims/`。`next-intl`、`next/link`、`next/image`、`next/navigation`、`next-themes` 和 hooks 都改为静态版本 |
| 渲染上下文 | `runtime.ts`，提供 locale、站点、文案和 `localePath()` |
| 文案 | `i18n/messages.ts`（从 toolso 移植），以及 Qoo.IM 自己补充的 `i18n/qooim-*.ts` |
| 浏览器端交互 | `src/ui/toolso.js`，加上在首次绘制前执行的 `toolso-init.js`。交互通过 `data-*` 属性约定，见 `i18n/qooim-client.ts` 开头的注释 |

改动样式后，依次运行：

```bash
pnpm build:css
pnpm check
pnpm test:p12
pnpm template:preview
```

## M13a：富字段、标签和多分类

在 API v1 上继续只增不改，老模板不需要修改。

- **条目新增字段**（`PublicResource`，都是可选的）：
  - `logo`：本站媒体库中的方形图，结构同 `image`；
  - `details`：`tagline`、`features`、`useCases`、`pros`、`cons`、`content`（Markdown）、`faqs`、`pricing`。目录页条目只带 `tagline` 和 `pricing`，详情页带全部字段；
  - `categories`：条目所属的全部分类，主分类在前；
  - `tags`：本站标签；
  - `published_at`、`updated_at`：本站首次发布时间和最近一次发布时间，ISO 8601 UTC 格式。
- **标签页**：`/<locale>/<catalogPath>/tag/<id>` 渲染目录页，同时传入 `tagPage`；目录页还会传入本语言可见的 `tags`。标签页和分类页一样会被索引，`?tag=` 筛选结果页是 noindex，标签不存在时返回 404。
- **Markdown 必须当作不可信内容处理**：不能把它当作 HTML 直接插入页面。React 模板可以使用 `react-markdown` 和 `remark-gfm`（模板目录允许导入这两个包），不要启用原始 HTML，并保留默认的链接过滤。字符串模板如果要显示长文，需要自己做转义。
- **公开 API**：`/api/tags?locale=` 返回标签及条目数；`/api/search` 支持 `tag=` 参数。

## M13b：榜单

- **榜单页**：`/<locale>/<catalogPath>/collection/<id>` 渲染目录页，同时传入 `collectionPage`（`PublicCollection`：`id`、`label`、`description`、`count`）。条目按榜单里的顺序排列；有关键词时按相关度排序。榜单页会被索引，hreflang 只列出该榜单有条目的语言。榜单不存在、已停用或在该语言下没有名称或可见条目时，返回 404。
- **首页**：`TemplateHomePage.collections` 提供最多 4 个可见榜单，每个附带前 8 个条目。
- **公开 API**：`/api/collections?locale=` 返回榜单及条目数；`/api/search` 支持 `collection=` 参数。

## M14：程序化 SEO

- **替代品页**：`/<locale>/<catalogPath>/<slug>/alternatives` 渲染目录页，同时传入 `alternativesOf`（被比较的条目）。`result.items` 是共享分类或标签的其他条目，按重合度排序：每个共享分类计 2 分，每个共享标签计 1 分，最多 24 条。少于 3 条时页面设为 noindex，也不输出 hreflang。
- **对比页**：`/<locale>/<catalogPath>/compare/<a>-vs-<b>` 渲染目录页，同时传入 `comparison`（`PublicComparison`：标题、Markdown 正文、时间）。`result.items` 是这两个条目，正文和 FAQ 已去掉。只有在该语言已发布、且两个条目都可见时，页面才会返回。详情页通过 `comparisons` 拿到包含该条目的对比。
- **sitemap**：`/sitemap.xml` 包含每种语言的首页、目录、分类、标签、榜单和对比页，以及全部条目（带 `lastmod`）。超过 45,000 个地址时改为 sitemap index，指向 `/sitemap-<n>.xml`。
- **RSS**：`/<locale>/feed.xml` 列出该语言最新发布的 50 条。

## M15：静态页面与收录徽章

API v1 继续只增不改：没有实现新可选能力的 `basic`、`editorial` 模板行为不变。

- **静态页面**：`TemplateDefinition` 新增可选 `renderPage?: (page: TemplateStaticPage) => TemplateOutput`。`TemplateStaticPage` 的 `kind` 为 `"page"`，`key` 是 `about`、`privacy`、`terms`、`contact` 之一，另有 `title` 和不可信 Markdown `content`；其余站点、语言、canonical 和 alternates 字段与目录页相同。模板不实现 `renderPage` 时，服务器用转义后的纯文本段落兜底，不解释 Markdown 里的 HTML。
- **路径规则**：配置中存在某语言的页面时，`/<locale>/<key>` 才返回页面；否则 404。若站点 `catalogPath` 与某个 key 相同，目录优先，该 key 不再作为静态页面出现。页面 canonical 指向自身，hreflang 只列实际配置的语言版本，并进入 sitemap。
- **toolso**：`src/templates/toolso/pages/page.tsx` 使用站点导航和页脚外壳，正文用 `components/detail/shared.tsx` 的 `DetailMarkdown` 渲染；页脚只链接当前语言已配置的 about/privacy/terms/contact。
- **收录徽章**：`GET /badge/<locale>/<slug>.svg` 对所有模板可用，`?theme=dark` 切换深色版本。只有通过 `public_listing` 可见的条目才返回 200，未知、未发布或该语言不可见时返回 404。SVG 用 XML 文本转义和长度截断，颜色取站点 `templateParams.accentColor`（通过配置校验），只用 presentation attributes，不引入外部字体、图片或内联 `<style>`；响应为 `image/svg+xml`，带 `nosniff`，按公开资源缓存 1 小时。
- **toolso 详情页**：详情页新增“徽章”章节和目录项，展示浅色/深色预览及 `<a><img></a>` 嵌入代码；复制按钮复用 `src/ui/toolso.js` 的 `data-copy` 约定，文案在中英文 `qooim-catalog` 中维护。
