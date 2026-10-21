# 六组镜像审查工作表

日期：2026-10-20。本表把每组“已经有什么、还缺什么、签署前至少要读什么”列出来。证据文件是盘点，不是许可结论；审查人仍需逐项确认。

## 当前身份

| 范围 | 镜像 | 包数 | 许可正文 |
| --- | --- | --- | --- |
| 应用镜像（node-base / global-pnpm / next-swc / esbuild） | `sha256:f3cf0433...` | 70 应用包、88 Debian 包、172 通知、3 原生文件 | Node、pnpm、应用包文本在镜像内 |
| `postgres-image` | `sha256:77f58511...` | 53 apk 包 | 镜像内无正文 |
| `demo-proxy-image` | `sha256:d8542f48...` | 32 apk 包 | 镜像内无正文 |

## 1. node-base

- 证据：`third-party/image-evidence/node-base.json`（含 88 个 Debian 包名/版本、Node 二进制摘要、Node LICENSE、npm/corepack）。
- 已具备：Node v24.21.0、88 份 `/usr/share/doc/*/copyright`、Node `/usr/local/LICENSE`。
- 签署前至少确认：
  - Node 内含 OpenSSL/V8/ICU 等组件的通知与源码义务；
  - 88 个 Debian 包的 copyright 是否覆盖实际分发，源码获取方式是否可接受；
  - 没有把 Debian 的 GPL 组件与 AGPL 应用错误地当成同一链接作品。
- 已补：88 个 Debian 包的 copyright 正文和 Node LICENSE 已提取到 `third-party/image-notices/debian/` 与 `third-party/image-notices/node/`，逐包映射见 `debian/manifest.json`。
- 仍需补：Node 内含 OpenSSL/V8/ICU 的逐组件通知；Debian 源码获取方式。

## 2. global-pnpm

- 证据：`third-party/image-evidence/global-pnpm.json`（82 个随包依赖、67 个许可文件、15 个缺失）。
- 15 个缺文件：`@npmcli/agent`、`@npmcli/fs`、`balanced-match`、`cacache`、`chownr`、`eastasianwidth`、`err-code`、`imurmurhash`、`jackspeak`、`mkdirp`、`ms`、`package-json-from-dist`、`path-scurry`、`ssri`、`yallist`。
- 已补齐 12 个精确 tarball 内的通知文件，路径在 [补充通知目录](../third-party/image-notices/global-pnpm/manifest.json)。
- `imurmurhash@0.1.4` 的 tarball 无 gitHead 且无 LICENSE；已保存上游 master 的 LICENSE，并标记为“非精确发布版本”。
- 仍有 3 个包在精确 tarball 和上游发布修订中都没有独立许可正文：`@npmcli/agent@3.0.0`（ISC，作者 GitHub Inc.）、`eastasianwidth@0.2.0`（MIT，作者 Masaki Komagata）、`err-code@2.0.3`（MIT，作者 IndigoUnited）。
- 已为这 3 个包生成 **候选归属文本**，放在 `third-party/image-notices/global-pnpm/*-derived-attribution.txt`，并在 manifest 中标为 `candidate-only; maintainer confirmation required`。它们是“标准正文 + package.json 作者”的候选，不是 tarball 原文，不能直接当精确通知。
- 签署前至少确认：
  - 12 个通知文件与包版本的对应；
  - 上述 3 个包的归属处理；
  - `pnpm.cjs` 单文件捆绑代码的许可范围；
  - 是否需要把补充通知放进镜像或随镜像分发。
- 补充材料：`third-party/image-notices/global-pnpm/manifest.json` 与 12 个精确 tarball 通知、1 个上游 master 通知；仍未决的 3 个包在 `docs/IMAGE-REVIEW-WORKSHEET.md` 本节列明。
- 仍需补：3 个包的最终归属决定；补充通知进入镜像的方式。

## 3. next-swc

- 证据：`third-party/image-evidence/next-swc.json`（Next 与两个 SWC 包、两个原生二进制摘要）。
- 已具备：Next 16.4.2 MIT、SWC 包声明 MIT、二进制摘要。
- 签署前至少确认：
  - 两个 SWC 二进制内实际编译的 Rust crate 集合；
  - 每个 crate 的许可与通知；
  - 静态链接/分发义务。
- 仍需补：Rust 实际编译图与逐 crate 通知；Next 16.4.2 发布物没有提供 `packages/next-swc/Cargo.lock`，不能从 npm 包反推编译图。现有 `third-party/rust-lock/inventory.json` 是 librsvg（sharp 历史材料），不是 SWC 编译图。

## 4. esbuild

- 证据：`third-party/image-evidence/esbuild.json`（esbuild 0.28.2、`bin/esbuild` 摘要、MIT 正文）。
- 已补：esbuild `go.sum` 只固定 `golang.org/x/sys@v0.0.0-20220715151400`，其 BSD-3-Clause 正文已存；二进制字符串显示构建工具链为 **Go 1.26.5**，Go LICENSE 已保存。
- 签署前至少确认：
  - Go 运行时 BSD 通知如何随附；
  - 是否还有 `go.sum` 之外的静态链接代码。
- 仍需补：最终镜像内 esbuild 二进制与本次提取的版本一致性复核。

## 5. postgres-image

- 证据：`third-party/image-evidence/postgres-image.json`（53 个包的名称/版本/声明许可）。
- 已发现：
  - 1 个未声明包：`.postgresql-rundeps`（虚拟元包）；
  - 8 个 `GPL-2.0-only` Alpine 基础包（alpine-baselayout、apk-tools、busybox、scanelf 等）；
  - 镜像内没有 `/usr/share/licenses` 或 `/usr/share/doc` 正文。
- 签署前至少确认：
  - Alpine 包的 copyright 与源码获取方式；
  - PostgreSQL 自身许可与镜像内声明；
  - GPL-2.0-only 包与 AGPL 应用是独立镜像/聚合分发，不构成链接作品；如有疑问需法律意见；
  - `.postgresql-rundeps` 的实际内容与通知。
- 已补：`third-party/image-notices/alpine/manifest.json` 从 APKINDEX 匹配 46/53 个包的仓库、许可、origin 和 aports 定位；7 个未匹配（`.postgresql-rundeps` 虚拟包，以及 `libcrypto3`、`libssl3`、`libldap`、`nghttp2-libs`、`tzdata`、`zlib` 的镜像版本已不在当前索引）。
- 已补：未匹配版本的上游许可正文（OpenSSL 3.5.8、OpenLDAP 2.6.14、nghttp2 1.69.0、zlib 1.3.2、tzdata 2026d）在 `third-party/image-notices/alpine/upstream/manifest.json`。
- 仍需补：Alpine 打包层通知/APKBUILD 依据；`.postgresql-rundeps` 说明；Alpine 包许可正文（上游正文不等同 Alpine 包通知）。

## 6. demo-proxy-image

- 证据：`third-party/image-evidence/demo-proxy-image.json`（32 个包、11 种声明、Caddy 二进制摘要）。
- 已发现：Caddy Apache-2.0；镜像内无许可正文；Alpine 包含 GPL-2.0-only。
- 签署前至少确认：
  - Caddy 的 Apache-2.0 正文与 NOTICE；
  - Go 依赖与 Alpine 包通知；
  - 演示镜像是否实际随发行提供（Compose 会拉取，不能当作“不发行”）。
- 已补：`third-party/image-notices/alpine/manifest.json` 匹配 29/32 个包的仓库/许可/origin；`libcrypto3`、`libssl3`、`zlib` 的镜像版本已不在当前索引。
- 已补：Caddy 2.11.7 的 Apache-2.0 正文在 `third-party/image-notices/caddy/`；上游仓库没有独立 NOTICE 文件；二进制字符串显示 **Go 1.26.8**，Go LICENSE 已保存。
- 仍需补：Caddy 的 Go 模块依赖通知；Alpine 包正文/来源。

## 签署格式

在 `third-party/image-review.json` 对应 scope 填：

```json
{
  "status": "complete",
  "reviewer": "实际审查人",
  "reviewedAt": "2026-10-20",
  "detail": "核对了什么、结论、保留的边界",
  "evidence": [
    { "file": "third-party/image-evidence/node-base.json", "sha256": "..." }
  ]
}
```

没有完成上述阅读时保持 `pending`。`detail` 不能只写“已审查”；至少写明：镜像 digest、组件范围、通知/源码结论、仍未验证的部分。

## 当前结论

六组已于 2026-10-21 由 QooIM 带保留签署：node-base、global-pnpm、next-swc、esbuild、postgres-image、demo-proxy-image。源码和镜像门禁均已通过；各组的保留项仍在 `image-review.json` 的 `detail` 中。逐组检查方法见 [镜像分发人工审查指南](IMAGE-REVIEW-GUIDE.md)；决定记录见[逐组决定卡](IMAGE-DECISION-CARDS.md)。
