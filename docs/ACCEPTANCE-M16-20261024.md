# M16 验收记录：收尾功能与镜像裁剪

日期：2026-10-24。分支 `m16-finish`。这是本地回归记录，不是发布批准。

## 结果

- check、build、P0–P16 全部通过（P16 为 13/13）。P7 的 AI 任务列表排序测试在并行回归时偶发失败一次，单独重跑 18/18 通过。
- `test:docker` 用裁剪后的镜像完整通过。
- `release:check` 通过。`test:release` 和 `release:check:image` 只有镜像门禁不通过，原因是 Dockerfile 和依赖变化。镜像证据已重新采集，等 QooIM 确认，见 [复核材料](IMAGE-EVIDENCE-REVIEW-PACKET-20261024-M16.md)。

## 内容

- **投稿附图**（迁移 019）：
  - 读者投稿可以附一张 JPEG、PNG 或 WebP 图片，不超过 1 MiB，边长不超过 4096。图片按文件内容校验，不信任声明的类型。
  - 审核前，图片存放在 `submission_image` 表，不进媒体库，也不占媒体库配额。每个站点待审图片合计不超过 100 MiB。
  - 后台审核页可以预览图片。预览接口带 `nosniff` 和 `sandbox` CSP。
  - 审核接受且提交之后，图片导入媒体库，作为草稿的 logo；如果此时草稿已被别人修改，就不设置 logo。导入失败（例如超出配额）时，投稿照常接受，图片保留，后台显示失败原因。
  - 审核拒绝时，图片立即删除。已审核超过 30 天的投稿，图片由维护任务清理。
- **对比页 AI 起草**：`GET /content/<site>/publications?ids=a,b` 按资源标识查询，一次最多 20 个，不再只限已加载的前 100 条。
- **basic、editorial 模板**：
  - 显示 logo、tagline、价格、标签、Markdown 概述、功能、使用场景、优缺点和 FAQ，并输出 FAQPage JSON-LD。Markdown 渲染规则与 toolso 相同。
  - 支持替代品页和对比页。
  - 分类、标签和榜单页保留搜索框和刊头。
- **镜像裁剪**：
  - Dockerfile 在构建后运行 `pnpm prune --prod`，并删除 `.next/cache`。镜像从 1.37 GB 降到约 1.08 GB，Tailwind、TypeScript、Playwright 不再进入镜像。
  - CLI 和 worker 需要 `tsx`，因此它改为运行时依赖。

## Codex 审查

审查提出 5 条，已全部修复：
- 导入改到审核事务之后；
- 待审图片设总量上限并定期清理；
- 预览保留 sandbox CSP；
- 缩略图尺寸改用样式表；
- 分类、标签页恢复搜索框。

## 已知限制

- 导入失败的投稿图片，目前只能等管理员下载后手动上传到媒体库。
