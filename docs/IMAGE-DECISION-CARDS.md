# 六组镜像逐组决定卡

日期：2026-10-20。每组一页，供维护者/指定审查人圈选并签署。**卡片不是许可结论**；未完成阅读时保持 `pending`。签署后把结论写进 `third-party/image-review.json`，再运行 `pnpm release:check:image`。

## 当前记录（2026-10-21）

| 组 | 决定 | reviewer | 门禁 |
| --- | --- | --- | --- |
| node-base | B 带保留接受 | QooIM | complete |
| global-pnpm | A 接受（3 个候选归属已记录） | QooIM | complete |
| next-swc | **B 带保留接受**（无逐 crate 通知的风险已记录） | QooIM | complete |
| esbuild | B 带保留接受 | QooIM | complete |
| postgres-image | B 带保留接受 | QooIM | complete |
| demo-proxy-image | B 带保留接受 | QooIM | complete |

六组的 `detail` 已写入 `third-party/image-review.json`，保留项仍有效；`next-swc` 的逐 crate 风险已明确接受。

通用边界：

- 盘点证据只证明镜像里有哪些包/文件/摘要，不做 ELF 链接分析，也不替代法律意见。
- “已补通知”不等于“该组件许可已完全满足”；每张卡的“未证明”必须一起读。
- 应用镜像 digest：`sha256:f3cf0433...`；PostgreSQL `sha256:77f58511...`；Caddy `sha256:d8542f48...`。

---

## 1. node-base

**范围**：`node:24-bookworm-slim@sha256:0e0ff40c...`，Node v24.21.0，88 个 Debian 包。

**已核对事实**

- 88 个 Debian 包的 copyright 正文已从镜像导出，逐包映射在 [debian manifest](../third-party/image-notices/debian/manifest.json)。
- Node `/usr/local/LICENSE` 已保存；Node 二进制摘要已记录。
- 镜像内 172 份许可/版权文件、3 个原生文件（esbuild + 两个 SWC）。

**未证明 / 仍在范围外**

- Node 内含 OpenSSL/V8/ICU 等组件的逐组件通知没有单独列出。
- Debian 包的源码获取方式/书面要约没有逐包确认。
- 没有做二进制链接分析。

**请圈选**

- [ ] A. 接受：以镜像内 88 份 copyright + Node LICENSE 为通知基础，并记录 Debian 源码获取方式。
- [ ] B. 带保留接受：先接受现有通知，但把 Node 内含组件和 Debian 源码义务列为发行后补证项。
- [ ] C. 继续 pending：要求逐组件 Node 通知和 Debian 源码要约后再签。

**签署**：reviewer __________ 日期 __________ detail（必须写保留项）______________________________

---

## 2. global-pnpm

**范围**：pnpm 10.11.1，82 个随包依赖。

**已核对事实**

- 67 个包自带许可文件；15 个原来缺文件。
- 已从精确 npm tarball 补齐 **12 个**通知；`imurmurhash@0.1.4` 使用上游 master LICENSE，标为“非精确版本”。
- 3 个包在精确 tarball/发布修订中没有独立正文：`@npmcli/agent@3.0.0`（ISC，GitHub Inc.）、`eastasianwidth@0.2.0`（MIT，Masaki Komagata）、`err-code@2.0.3`（MIT，IndigoUnited）。
- 这 3 个已生成 `*-derived-attribution.txt` 候选，manifest 标为 `candidate-only; maintainer confirmation required`。

**未证明 / 仍在范围外**

- 3 个候选文本不是 tarball 原文；是否接受“标准正文 + package.json 作者”需要明确决定。
- `pnpm.cjs` 单文件捆绑代码的逐包通知没有单独展开。
- 补充通知目前放在源码候选，尚未决定是否复制进镜像。

**请圈选**

- [ ] A. 接受：确认 12 个精确通知 + imurmurhash 上游通知 + 3 个候选归属，并把候选决定写进 `review.json`。
- [ ] B. 只接受 13 个（12 精确 + imurmurhash），3 个继续 pending 或替换依赖。
- [ ] C. 继续 pending：要求 3 个包的上游书面确认或改用有明确许可正文的替代依赖。

**签署**：reviewer __________ 日期 __________ detail（明确 3 个包的处理）______________________________

---

## 3. next-swc

**范围**：`next@16.4.2`、`@next/swc-linux-arm64-gnu`、`@next/swc-linux-arm64-musl`，2 个原生二进制。

**已核对事实**

- 三个包均声明 MIT；两个 `.node` 二进制摘要已记录。
- Next 16.4.2 发布物没有 `packages/next-swc/Cargo.lock`；无法从 npm 包反推实际编译的 Rust crate 图。

**未证明 / 仍在范围外**

- 两个二进制内实际包含哪些 Rust crate、各自许可/通知，未知。
- 静态链接义务没有评估。
- 没有构建级 SBOM。

**请圈选**

- [ ] A. 接受：按 Next/SWC 包级 MIT 声明分发，并在 `detail` 中明确“未取得逐 crate 通知”的保留。
- [ ] B. 带保留接受：先接受包级 MIT，但把逐 crate 通知列为上线后/下个发行前补证项。
- [ ] C. 继续 pending：要求 Next/SWC 构建材料或逐 crate 通知后再签。

**签署**：reviewer __________ 日期 __________ detail（若选 A/B，必须写清风险）______________________________

---

## 4. esbuild

**范围**：`esbuild@0.28.2`、`@esbuild/linux-arm64@0.28.2`，`bin/esbuild`。

**已核对事实**

- 两个包声明 MIT；esbuild MIT 正文已记录。
- `go.sum` 只固定 `golang.org/x/sys@v0.0.0-20220715151400`，其 BSD-3-Clause 正文已保存。
- 二进制字符串显示 Go **1.26.5**；Go LICENSE 已保存。
- 二进制摘要已记录。

**未证明 / 仍在范围外**

- Go 运行时 BSD 通知如何随镜像分发尚未决定。
- 最终镜像内 esbuild 二进制与本次提取版本的逐字节一致性还要在冻结镜像上复核。
- 未做其他静态链接分析。

**请圈选**

- [ ] A. 接受：以 esbuild MIT + x/sys BSD + Go 1.26.5 LICENSE 为通知基础，并在冻结镜像上复核二进制摘要。
- [ ] B. 带保留接受：先接受，但把 Go runtime 通知随附方式列为发行前动作。
- [ ] C. 继续 pending：要求完整 Go 构建信息/SBOM 后再签。

**签署**：reviewer __________ 日期 __________ detail ______________________________

---

## 5. postgres-image

**范围**：PostgreSQL 镜像 `sha256:77f58511...`，53 个 apk 包。

**已核对事实**

- 53 个包的名称/版本/声明许可已记录；APKINDEX 匹配 46 个，7 个未匹配（虚拟包或旧版本已不在索引）。
- 1 个未声明包：`.postgresql-rundeps`。
- 8 个 `GPL-2.0-only` Alpine 基础包（alpine-baselayout、apk-tools、busybox、scanelf 等）。
- 镜像内没有 `/usr/share/licenses` 或 `/usr/share/doc` 正文。
- OpenSSL 3.5.8、OpenLDAP 2.6.14、nghttp2 1.69.0、zlib 1.3.2、tzdata 2026d 的上游许可正文已保存。
- 这是与 AGPL 应用分离的数据库镜像，通过 Compose/网络连接。

**未证明 / 仍在范围外**

- Alpine 打包层 copyright/APKBUILD 通知没有收齐；上游正文不等于 apk 包通知。
- `.postgresql-rundeps` 的实际内容/通知未确认。
- GPL-2.0-only 基础包与 AGPL 应用是否构成聚合/独立作品，需要审查人判断，不能由工具代替。

**请圈选**

- [ ] A. 接受：按独立数据库镜像分发，记录 Alpine 源码定位和上游通知；明确 GPL 组件与 AGPL 应用为分离镜像/聚合分发的立场。
- [ ] B. 带保留接受：先接受，但把 Alpine 包级 copyright / `.postgresql-rundeps` 说明列为发行前补证项。
- [ ] C. 继续 pending：要求 Alpine APKBUILD/版权正文和未声明包说明后再签。

**签署**：reviewer __________ 日期 __________ detail（必须写 GPL/聚合判断）______________________________

---

## 6. demo-proxy-image

**范围**：Caddy 镜像 `sha256:d8542f48...`，Caddy v2.11.7，32 个 apk 包。

**已核对事实**

- Caddy Apache-2.0 正文已保存；上游 v2.11.7 没有独立 NOTICE 文件（已核对 404）。
- 二进制字符串显示 Go **1.26.8**；Go LICENSE 已保存。
- 32 个包中 29 个匹配 APKINDEX；`libcrypto3`、`libssl3`、`zlib` 的镜像版本已不在当前索引。
- 镜像内没有许可正文。

**未证明 / 仍在范围外**

- Caddy 的 Go 模块依赖通知没有逐项收集。
- Alpine 包级 copyright/APKBUILD 通知没有收齐。
- 演示镜像由 Compose 拉取，不能当作“不发行所以不用管”。

**请圈选**

- [ ] A. 接受：以 Caddy Apache-2.0 + Go 1.26.8 LICENSE 为基础，记录 Alpine 源码定位；把 Go 依赖/Alpine 正文列为保留项。
- [ ] B. 带保留接受：先接受，但要求发行前补齐 Go 模块通知和 Alpine copyright。
- [ ] C. 继续 pending：要求完整 Go 依赖与 Alpine 通知后再签。

**签署**：reviewer __________ 日期 __________ detail ______________________________

---

## 签署后操作

1. 在 `third-party/image-review.json` 对应 scope 填 `status:"complete"`、真实 `reviewer`、`reviewedAt`、`detail`，并保留当前 evidence SHA。
2. 把本卡对应选项和 `detail` 一起存档；不要只写“已审查”。
3. 运行：

```bash
pnpm release:check:image
```

六组均已完成，镜像门禁已通过。任何证据文件或输入变化都会重新要求对应组审查；保留项不因门禁通过而消失。
