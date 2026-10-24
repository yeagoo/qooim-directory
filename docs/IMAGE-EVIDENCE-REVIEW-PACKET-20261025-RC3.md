# 镜像证据复核材料（2026-10-25，v0.2.0-rc.3 候选）

**这份材料不是签字。** `third-party/image-review.json` 中六个证据范围现在全部是 `pending`。在 QooIM 本人确认之前，`pnpm release:check:image` 会一直失败。

## 候选镜像

- 镜像：`navigation-network:rc3-candidate`，`sha256:aa13093e286aab2cc7d662de63ec248963905fd442518853f8a3b82e8676a944`，linux/arm64，构建自 `main` 42390d8（含 M17–M19 文档）。拟定 tag：`v0.2.0-rc.3`。
- 和上次确认的 rc.2 镜像 `sha256:83d35168…` 相比，只有应用代码变了：
  - M17：新站点默认使用 toolso 模板；
  - M18：站点 persona、统一分发、查重和自动发布检查、定时发布、AI 额度预扣、手动粘贴模式；
  - M19：后台按方案 3（黑白高对比）改版。
- 上次确认的依据是 [rc.2 复核材料](IMAGE-EVIDENCE-REVIEW-PACKET-20261024-RC2.md)。

## 六个固定输入的变化

| 文件 | 是否变化 | 原因 |
| --- | --- | --- |
| `package.json` | 变化 | `test:p16` 加了一个测试文件，新增 `test:p17` 脚本；依赖没有变。 |
| 其余五个 | 未变化 | — |

## 证据对比

- 六个证据文件只有镜像身份、inventory 哈希和采集时间变了，观察内容与 rc.2 相同。
- 应用运行时 npm 包（191 个）、操作系统软件包（88 个）和许可声明（293 条）与 rc.2 完全相同，没有新增或删除。
- 后台使用的 Geist 字体原本就在镜像里（OFL），这次只是在后台也提供，没有新增文件来源。

## 请 QooIM 确认的事项

1. 沿用上次的决定和保留意见。
2. 同意把这个镜像作为 `v0.2.0-rc.3`。

确认后，按以前的格式在 `image-review.json` 中填写 reviewer、reviewedAt 和 `status: complete`，然后打 tag。这些字段必须由 QooIM 本人确认后才能填写。
