> 当前状态（2026-10-21）：源码和镜像门禁均已通过；本文下面“四项/未关闭”的描述是当时记录。

# P5 后续：依赖来源与发行边界 Review

日期：2026-10-18。上一轮记录的 8 项缺失许可文本，本轮补齐其中 4 项的包级许可通知；其余 4 项仍保留，严格发行检查继续失败。没有将包级文本补齐等同于原生二进制或完整镜像分发审计通过。本轮平台是 ARM64；其他平台缺少固定来源文本的包会单独列为未解决，不复用 ARM64 元数据。

## 已核查并固化

| 包 / 版本 | 固定上游修订 | 本地文本 |
| --- | --- | --- |
| @esbuild/linux-arm64 0.28.2 | npm gitHead `609683d892977362a0f99026cb74b96263d728a9` | [MIT 通知](../../third-party/licenses/esbuild-0.28.2.txt) |
| @next/env 16.4.2 | v16.4.2 标签提交 `2864b1772c37242a9b40ab4d366eb7d368c2a070` | [MIT 通知](../../third-party/licenses/next-16.4.2.txt) |
| @next/swc-linux-arm64-gnu 16.4.2 | 同上 | 同上 |
| @next/swc-linux-arm64-musl 16.4.2 | 同上 | 同上 |

[结构化取证记录](../../third-party/review.json) 包含 npm 精确版本 URL、SRI、安装包元数据 SHA-256、固定修订的原文 URL、许可文本 SHA-256 与锁文件 SHA-256。构建只读取这些本地文件，不联网下载新许可。通知会附到 THIRD-PARTY-NOTICES，来源与摘要写入源码清单。

依据：[esbuild 对应修订 LICENSE](https://github.com/evanw/esbuild/blob/609683d892977362a0f99026cb74b96263d728a9/LICENSE.md)、[Next 对应修订 license.md](https://github.com/vercel/next.js/blob/2864b1772c37242a9b40ab4d366eb7d368c2a070/license.md)。MIT 文本只覆盖这里明确核对的包级通知；SWC Rust、esbuild Go 依赖等原生内含代码仍须另查。

## 未解决项的具体原因

- `@better-auth/utils@0.5.0`：npm provenance 的源修订指向 `f03c1c76aff7bfa3f4de4af47b112315c770a0d1`，[该修订目录](https://github.com/better-auth/utils/tree/f03c1c76aff7bfa3f4de4af47b112315c770a0d1) 没有 LICENSE。当前主分支有许可证，不能未经核实替代发布修订。这里读取了 npm provenance 数据，没有宣称额外完成其 DSSE 签名验证。
- `client-only@0.0.1`：原始 npm 包只有 package.json、空 index.js 与 error.js；声明 MIT，但没有包专属版权行及完整许可文本。[npm 发布记录](https://registry.npmjs.org/client-only/0.0.1) 的 homepage/bugs 或发布者信息不足以凭空确定 Meta/Vercel 版权归属。没有用 Next 根许可证替代这个更早的独立发布包。
- 两个 `sharp-libvips` 1.3.4 平台包：README 列出 28 个底层组件版本、LGPL/MPL/BSD/MIT 等多种许可。[打包仓库的 Apache-2.0](https://github.com/lovell/sharp-libvips/blob/ebb95f8add54eee8bed840e3fb587e4cbec857d7/LICENSE) 不能覆盖内含第三方库。仍需逐项通知、准确版本源代码及分发方式核对。

没有在本轮替维护者联系上游或发送消息。以上问题不会阻止本地测试；公开发行门槛仍保留。包/平台/版本或锁文件变化后必须更新取证记录，不能自动沿用旧通知。

## Review 修复

1. **本地数据库密码漏检**：取消 localhost、127.0.0.1、db 等目标的密码豁免；只允许明确的 REPLACE 或完整环境变量引用，JSON 引号包裹的认证密钥同样检测；空用户名、查询参数、重复及编码的 password 参数也覆盖。测试密码在运行时拼接，避免把完整假秘密放进公开源码。
2. **依赖清单漏项**：先检查全部直接依赖和开发依赖实际安装且精确版本匹配，再检查必须的传递依赖。原来只遍历 pnpm store，删除根依赖链接也可能生成“完整”清单。安装路径不得跳到项目外或父工作区，避免导出镜像依赖校验借用外部安装树。
3. **通知证据可被改写**：构建校验锁文件、对应包元数据和本地许可文本摘要；重复记录、符号链接和不匹配均拒绝。未找到完整通知的 MIT 声明仍保留缺口。
4. **生成通知未纳入摘要**：THIRD-PARTY-NOTICES.txt 现在也进入文件 SHA 清单，逐包来源字段随清单导出。

`pnpm test:release` 不需要数据库或上游网络，验证以上失败路径；`pnpm test:p5` 验证备份恢复及源码接口；`pnpm build` 与独立源码构建验证最终包含本地取证记录。

## 验证结果

本轮新增发行测试10/10、受影响P5运维6/6通过；check、生产build、独立源码离线安装/build及生产依赖审计通过。最终源码Docker重建验收正常退出码0，覆盖全新安装、源码包下载及内部材料排除、邮件验证后的共享登录、GitHub审核发布与进程/数据库恢复。没有复跑或冒用上一轮容量数字。品牌、真实 GitHub/Google 应用联调、完整镜像系统/原生库核查仍是独立剩余项。旧站与生产环境保持原样。


可审查源码副本：`.local/release-review-final-20261018`；本轮日志：`.local/release-*.log`。严格 `release:check` 仍以退出码1列出4项未解决包，这是保留门槛的正确结果，不计作发行检查通过。源码清单中的生成通知及原始文件摘要已单独验证；临时测试容器、卷和hosts标记已清理。

后续 [镜像分发Review](DISTRIBUTION-REVIEW.md) 修复空许可及README链接发现问题，新增只读盘点与独立镜像门槛。本文四项包级缺口仍未关闭；源码候选检查与镜像检查是不同范围，不以包级通知推断完整镜像许可通过。

libvips的进一步来源证据和未解决义务见 [原生来源Review](NATIVE-SOURCE-REVIEW.md)，四项包级缺口仍未关闭，不能以新增单份许可正文替代完整原生包核查。

后续：2026-10-20 已通过 `pnpm.ignoredOptionalDependencies` 与干净安装移除未使用的 `sharp`，两个 `sharp-libvips` 平台包不再分发，包级缺口从 4 项降为 `@better-auth/utils@0.5.0` 与 `client-only@0.0.1` 两项。见 [源码许可与镜像证据推进 Review](../SOURCE-LICENSE-DECISIONS.md)。

后续（2026-10-20）：维护者按 MIT 归属决定关闭剩余两项（`@better-auth/utils@0.5.0`、`client-only@0.0.1`），通知文本和依据写入 `third-party/review.json`；`pnpm release:check` 已退出 0。镜像审查见 [源码许可 Review](../SOURCE-LICENSE-DECISIONS.md) 与 [镜像审查指南](../IMAGE-REVIEW-GUIDE.md)。

后续（2026-10-21）：维护者 QooIM 已带保留签署全部六组；`next-swc` 的逐 crate 风险按 option B 明确接受。`pnpm release:check:image` 已通过。
