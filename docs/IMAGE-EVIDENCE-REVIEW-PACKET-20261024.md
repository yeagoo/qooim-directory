# 镜像证据复核材料（2026-10-24，M12–M15 冻结候选）

**这份材料不是签字。** `third-party/image-review.json` 中六个证据范围现在全部是 `pending`。在 QooIM 本人确认之前，`pnpm release:check:image` 会一直失败。

## 候选镜像

- 镜像：`navigation-network:m15-candidate`，`sha256:75c881586d2f1310ca243f08cd15f6254edda250faaec1b054c2321c9c3bfb33`，linux/arm64。
- 构建来源：分支 `release-freeze`，包含 M12–M15 的全部代码，以及容器健康检查修复（见下）。
- 上一次确认：QooIM 于 2026-10-23 确认了 M6–M11 候选 `sha256:c73accb2…`，依据是 [复核材料](IMAGE-EVIDENCE-REVIEW-PACKET-20261023.md)。这次确认的内容保存在每个范围的 `previousReview` 和 `confirmation.previous` 中。

## 六个固定输入的变化

| 文件 | 是否变化 | 原因 |
| --- | --- | --- |
| `Dockerfile` | 变化 | 修复 `HEALTHCHECK`。原先用 `fetch()` 请求，但 `fetch()` 会丢掉 Host 头，`/health` 因此匹配不到管理域名，web 容器从 M3 起一直显示 unhealthy。现在改用 `node:http`，带上 Host 头请求。本地已验证 web、worker、db、proxy 四个容器都是 healthy。 |
| `package.json`、`pnpm-lock.yaml` | 变化 | M12 新增 clsx、lucide-react、tailwind-merge、geist、tailwindcss 等依赖，M13a 新增 react-markdown 和 remark-gfm。 |
| `compose.yaml`、`compose.demo.yaml`、`.dockerignore` | 未变化 | — |

## 证据对比

- **六个证据范围**（node-base、global-pnpm、next-swc、esbuild、postgres-image、demo-proxy-image）：重新采集后，除镜像身份和采集时间外，观察内容与上次确认时完全相同。基础镜像、全局 pnpm、esbuild、next-swc、Postgres 和代理镜像都没有变化。
- **应用运行时清单**（`.local/license-evidence/app-inventory.json`，未纳入版本库，可以在本地复核）：
  - 操作系统软件包与 M11 相同。
  - npm 运行时包从 94 个增加到 273 个，没有减少。新增的 179 个包按许可证统计：MIT 169、ISC 7、Apache-2.0 2（`didyoumean@1.2.2`、`ts-interface-checker@0.1.13`，都是 Tailwind 的依赖）、OFL-1.1 1（`geist@1.5.1` 字体）。
  - 这些包都已通过源码许可门禁：`pnpm release:check` 显示 `manualLicenseReview: []`。`dlv@1.1.3` 按维护者 2026-10-23 的决定作为 MIT 接受。
- **一个观察点**：Tailwind 及其依赖是开发依赖，但仍随 `node_modules` 进入了镜像，原因是镜像构建时没有裁剪开发依赖。它们都是宽松许可证，不影响合规，但会增加镜像体积。是否要在 Dockerfile 中裁剪开发依赖，可以作为后续优化，由维护者决定。

## 请 QooIM 确认的事项

1. 六个证据范围的观察内容与上次确认时相同，是否沿用上次的决定和保留意见。
2. 应用运行时新增的 179 个包（许可证分布见上）是否可以接受。
3. 是否同意 Dockerfile 的健康检查修改。

确认后，按以前的格式在 `image-review.json` 中填写 reviewer、reviewedAt 和 `status: complete`。这些字段必须由 QooIM 本人确认后才能填写。
