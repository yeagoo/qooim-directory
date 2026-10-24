# 镜像证据复核材料（2026-10-24，v0.2.0-rc.2 候选）

**这份材料不是签字。** `third-party/image-review.json` 中六个证据范围现在全部是 `pending`。在 QooIM 本人确认之前，`pnpm release:check:image` 会一直失败。

## 候选镜像

- 镜像：`navigation-network:rc2-candidate`，`sha256:83d351684c12fe18203cfec4b01fe388e5c1e778b2a2d030b30071814e5279fd`，linux/arm64。目标 tag：`v0.2.0-rc.2`。
- 和上一次确认的 M16 候选 `sha256:6c1cb935…` 相比，只多了一处改动：访问后台根地址 `/` 时，跳转到 `/admin`；未登录时再跳到登录页。上一次确认的依据是 [复核材料](IMAGE-EVIDENCE-REVIEW-PACKET-20261024-M16.md)。

## 六个固定输入的变化

| 文件 | 是否变化 | 原因 |
| --- | --- | --- |
| `package.json` | 变化 | 只是 `test:p16` 脚本新增了一个测试文件，依赖没有变。 |
| 其余五个 | 未变化 | — |

## 证据对比

- 六个证据范围除了镜像身份和采集时间，观察内容都与上次确认时相同。
- 应用运行时 npm 包（191 个）和操作系统软件包与上次完全相同。

## 请 QooIM 确认的事项

1. 沿用上次的决定和保留意见。
2. 同意把这个镜像作为 `v0.2.0-rc.2`。

确认后，按以前的格式在 `image-review.json` 中填写 reviewer、reviewedAt 和 `status: complete`，然后打 tag。这些字段必须由 QooIM 本人确认后才能填写。
