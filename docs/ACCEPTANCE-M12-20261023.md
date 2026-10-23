# M12 验收记录：toolso 前台模板（路线 C）

日期：2026-10-23。分支 `m12-toolso-ui`，尚未合并到 `main`，也没有推送。这是本地回归记录，不是发布批准。背景和取舍见 [toolso 对照清单](TOOLSO-COMPARISON-20261023.md)，开发说明见 [模板开发](TEMPLATE-DEVELOPMENT.md#m12react-模板首页与-toolso-模板)。

## 结果

```text
pnpm check                 通过（含 Tailwind 产物是否最新的检查）
pnpm build                 通过
P0 48/48   P1 88/88   P2 137/137   P3 39/39   P4 30/30   P5 11/11
P6 29/29   P7 18/18   P8 16/16     P9 20/20   P10 12/12  P11 16/16
P12 30/30（render 6、home 3、catalog 8、browser 13）
pnpm test:release          68/69：失败的是镜像门禁（预期，原因见下）
pnpm release:check         通过（源码许可，含 dlv@1.1.3 的维护者决定）
pnpm release:check:image   失败：Image review input changed: pnpm-lock.yaml（预期）
```

另外做了两项实际运行检查：
- 用 Next 生产构建跑真实服务，确认 React 模板能渲染，旧模板不受影响。
- 用本分支构建的镜像（`navigation-network:m12-preview`）启动本地 HTTPS 演示，atlas 站切到 toolso 模板。首页、列表页、分类页、详情页和 404 页都正常，浏览器控制台没有错误。

## 内容

- **模板 API v1 只增不改**：
  - `render` 可以返回 React 元素，服务端渲染一次，不在浏览器里执行 React；
  - 新增可选的 `renderHome`，以及 `/`、`/<locale>` 首页路由；
  - 新增分类页 `/<locale>/<catalog>/category/<id>`；
  - 详情页附带 `categories` 和 `related`；
  - 新增参数 `accentColor`、`motion`。
- **toolso 模板**：
  - 移植了导航栏、页脚、首页、列表页、分类页、详情页和 404 页，组件代码尽量保持原样；
  - 用兼容层（shim）替代 Next 专用的 API 和 React hooks；
  - 浏览器端交互由 `src/ui/toolso.js` 实现；
  - SEO 方面输出标题、og、hreflang（含 x-default）和 JSON-LD。
- **CSP 不放宽**：没有内联样式和内联脚本；品牌色通过 `/assets/theme/<hex>.css` 提供；字体放在本地。
- **许可**：toolso 部分保留 Apache-2.0（Copyright 2025 CoolChange.AI），并附 NOTICE；Geist 字体为 OFL；`dlv@1.1.3` 由维护者决定按 MIT 接受。

## 已知限制与后续

- **资源数据还很少**：没有 logo、标签、定价、长文、FAQ、浏览量。toolso 里对应的区块暂时隐藏，logo 用首字母代替。补齐数据是 M13 的范围。
- **文案里写的是"工具"**：沿用 toolso 文案，比如"全部产品""搜索工具"。如果站点收录的不是工具类内容，需要改成可配置的文案。
- **sitemap 还没有收录首页和分类页**：计划放在 M14（程序化 SEO）。
- **镜像 evidence 需要重新采集**：`package.json` 和 `pnpm-lock.yaml` 变了，已签名的镜像 evidence 已经失效。建议在 M13–M15 完成、代码冻结后，统一重新采集一次，再交 QooIM 签名。在那之前，这个分支合并进 `main` 会让 `main` 上的镜像门禁失败。
- **后台还不能直接编辑新参数**：`accentColor` 等模板参数目前只能通过完整配置 JSON 修改。
