# 镜像分发补充通知

这些文件用于补充镜像盘点中缺少独立许可正文的组件。它们不是许可结论，也不替代人工审查。

## node-base

`debian/manifest.json` 记录 88 个 Debian 包到 copyright 正文的逐包映射，`node/LICENSE` 保存 Node 镜像内的 LICENSE。它们来自镜像盘点，不是 Node 内含 OpenSSL/V8/ICU 的完整通知。

## global-pnpm

- `global-pnpm/manifest.json`：15 个 pnpm 随包依赖的精确 npm 归档、SRI、tarball 摘要、gitHead、通知文件摘要和处理状态。
- 12 个包从精确 tarball 取得通知；`imurmurhash@0.1.4` 使用上游 master LICENSE 并标记为非精确版本。
- `@npmcli/agent@3.0.0`、`eastasianwidth@0.2.0`、`err-code@2.0.3` 在精确 tarball 和发布修订中没有独立许可正文；已生成 `*-derived-attribution.txt` 候选（标准正文 + package.json 作者），manifest 标为 `candidate-only; maintainer confirmation required`，仍需维护者确认。

## esbuild

`esbuild/manifest.json` 记录 `golang.org/x/sys@v0.0.0-20220715151400` 的精确模块归档与 BSD-3-Clause 正文；二进制字符串显示 Go 1.26.5，Go LICENSE 已保存。

## Alpine

`alpine/manifest.json` 记录 PostgreSQL 镜像 46/53、Caddy 镜像 29/32 个包的 APKINDEX 仓库、许可、origin 和 aports 定位。它只是元数据定位，不是许可正文；7 个/3 个未匹配包已在 manifest 中标出。

## Caddy

`caddy/manifest.json` 记录 Caddy 2.11.7 Apache-2.0 正文和二进制内的 Go 1.26.8 LICENSE；Go 模块依赖通知仍未收齐。

## Alpine / Caddy 上游

`alpine/upstream/manifest.json` 保存 OpenSSL 3.5.8、OpenLDAP 2.6.14、nghttp2 1.69.0、zlib 1.3.2、tzdata 2026d 的上游许可正文；`caddy/caddy-2.11.7-LICENSE.txt` 保存 Caddy Apache-2.0 正文。它们不是 Alpine/Caddy 打包层通知，也不替代 apk 包版权文件。

## 其他范围

Alpine 包正文、Next SWC 的 Rust 编译图和 Go 工具链通知尚未在此目录补齐；审查状态与缺口见 [六组镜像审查工作表](../../docs/IMAGE-REVIEW-WORKSHEET.md)。
