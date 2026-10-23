# M13a 验收记录：富字段、标签和多分类

日期：2026-10-24。分支 `m13a-content-model`，尚未合并到 `main`，也没有推送。这是本地回归记录，不是发布批准。范围来自 [toolso 对照清单](TOOLSO-COMPARISON-20261023.md) 的“二、数据”。维护者在 2026-10-24 确定了四项取舍：标签按站点维护；长文用 react-markdown + remark-gfm 渲染；支持多分类；M13 拆成 M13a 和 M13b 两步。

## 结果

```text
pnpm check                 通过
pnpm build                 通过
P0 48/48   P1 88/88   P2 137/137   P3 39/39   P4 30/30   P5 11/11
P6 29/29   P7 18/18   P8 16/16     P9 20/20   P10 12/12  P11 16/16
P12 35/35
P13 18/18（迁移 1、数据层 8、toolso 模板 9）
pnpm test:release          68/69：失败的是镜像门禁（预期）
pnpm release:check         通过（新增约 100 个依赖包，均为 MIT 或 ISC，不需要人工补审）
pnpm release:check:image   失败：Image review input changed: pnpm-lock.yaml（预期）
```

另外用 Next 生产构建跑了一次真实服务：
- atlas 站切到 toolso 模板，并发布了一条带长文、FAQ、标签和其他分类的条目。
- 以下页面都返回 200：详情页（中文和英文）、标签页、其他分类页、`?tag=` 筛选页、`/api/tags`。服务日志里没有错误。
- 长文中的表格和列表正常渲染。`javascript:` 链接、`<script>` 和外链图片都被过滤，外部链接带 `nofollow ugc`。

## 内容

- **数据**：
  - 迁移 `015-content-model.sql` 新增本站标签表。
  - 发布快照新增其他分类、标签、富字段、logo，以及首次发布时间和最近一次发布时间。已有的发布从审计日志补齐时间。
  - 公开视图同步加上这些列。
  - 规则见 [内容协议](P2-CONTENT.md#m13a富字段标签和多分类)。
- **公开路由**：新增标签页 `/<locale>/<catalog>/tag/<id>`（会被索引，hreflang 只列出该标签有条目的语言）、`?tag=` 筛选（noindex）和 `/api/tags`。分类页和分类计数都包含其他分类。
- **模板 SDK**：只增不改，新增 `logo`、`details`、`categories`、`tags`、`published_at`、`updated_at`、`tag`、`tags`、`tagPage`，见 [模板开发](TEMPLATE-DEVELOPMENT.md#m13a富字段标签和多分类)。basic 和 editorial 模板没有改动。
- **toolso 模板**：
  - 卡片和详情页显示 logo、tagline、定价、发布日期和标签。
  - 详情页新增概览（Markdown）、主要功能、使用场景、优缺点、FAQ 几个区块，以及 FAQPage JSON-LD；侧栏显示全部分类和标签。
  - 新增标签页。
  - 移植了 toolso 的 `pricing`、`faq`、`pros-cons`、`prose-section` 组件，并保留 Apache-2.0 署名。
- **后台**：
  - 新增“本站标签”面板。
  - 修复资源表单修改名称或说明时会清掉 JSON 里其他字段的问题。
  - 修复已发布、没有草稿的条目在重新编辑或比较主档新版时丢掉其他分类和标签的问题。

## 已知限制与后续

- **富字段只能在 JSON 里编辑**：tagline、功能、FAQ、长文等字段，后台只能在完整 JSON 中编辑，没有专门的表单。M13b 的 AI 补全会生成这些字段的候选。
- **react-markdown 依赖 Next 打包**：react-markdown 的模块会导入 React hooks。在 Next 构建中它被打包进路由，同步的 `Markdown` 组件不会调用 hooks，所以能正常工作。如果以后把它配置成 Next 的外部包，渲染会失败。
- **basic 和 editorial 模板还不显示新字段**。
- **sitemap 还没有收录标签页**，和首页、分类页一起放到 M14。
- **镜像 evidence 仍需重新采集**：`package.json` 和 `pnpm-lock.yaml` 又有变化。按原计划，在 M13–M15 完成、代码冻结后统一重新采集，再交 QooIM 签名。
- **M13b**：榜单（热门、编辑精选）和 AI 补全富字段。
