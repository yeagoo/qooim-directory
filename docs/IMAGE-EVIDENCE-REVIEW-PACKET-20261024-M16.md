# 镜像证据复核材料（2026-10-24，M16 候选）

**这份材料不是签字。** `third-party/image-review.json` 中六个证据范围现在全部是 `pending`。在 QooIM 本人确认之前，`pnpm release:check:image` 会一直失败。

## 候选镜像

- 镜像：`navigation-network:m16-candidate`，`sha256:6c1cb9358f887a038df4c7634e2e33df34a4d4ae7bd4fcf36bde8fdecf02e02e`，linux/arm64。
- 构建来源：分支 `m16-finish`，包含投稿附图、basic/editorial 模板富字段、对比页查询和镜像裁剪。
- 上一次确认：QooIM 于 2026-10-24 确认了 M12–M15 候选 `sha256:75c88158…`，依据是 [复核材料](IMAGE-EVIDENCE-REVIEW-PACKET-20261024.md)。这次确认的内容保存在每个范围的 `previousReview` 和 `confirmation.previous` 中。

## 六个固定输入的变化

| 文件 | 是否变化 | 原因 |
| --- | --- | --- |
| `Dockerfile` | 变化 | 构建后新增一行：`RUN pnpm prune --prod && rm -rf .next/cache`。它删掉开发依赖和 Next 构建缓存，镜像从 1.37 GB 降到约 1.08 GB。 |
| `package.json`、`pnpm-lock.yaml` | 变化 | `tsx@4.23.15` 从开发依赖改为运行时依赖，因为 CLI 和 worker 都要用它；版本没有变。另外新增了 `test:p16` 脚本。 |
| `compose.yaml`、`compose.demo.yaml`、`.dockerignore` | 未变化 | — |

## 证据对比

- **六个证据范围**（node-base、global-pnpm、next-swc、esbuild、postgres-image、demo-proxy-image）：重新采集后，除镜像身份和采集时间外，观察内容与上次确认时相同。esbuild 是 tsx 的依赖，仍在镜像中，版本和二进制都没有变化。
- **应用运行时清单**（`.local/license-evidence/app-inventory.json`，未纳入版本库，可以在本地复核）：
  - 操作系统软件包与上次相同。
  - npm 运行时包从 273 个减到 191 个，只减不增。删掉的 82 个包按许可证统计：MIT 73、ISC 5、Apache-2.0 3、OFL 1（`geist` 字体包）。镜像里使用的 Geist 字体文件来自 `src/ui/fonts`，附带 OFL 许可，因此不受影响。
  - `pnpm release:check` 通过，`manualLicenseReview: []`。
- 用这个镜像跑 `pnpm test:docker` 完整通过，覆盖空库初始化、三个站点、登录、worker 重启和数据库恢复。

## 请 QooIM 确认的事项

1. 六个证据范围的观察内容与上次确认时相同，是否沿用上次的决定和保留意见。
2. 运行时包减少 82 个、没有新增，是否接受。
3. 是否同意这次对 Dockerfile 和依赖的修改：裁剪开发依赖，`tsx` 改为运行时依赖。

确认后，按以前的格式在 `image-review.json` 中填写 reviewer、reviewedAt 和 `status: complete`。这些字段必须由 QooIM 本人确认后才能填写。
