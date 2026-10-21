# 源码许可与镜像分发证据推进 Review

日期：2026-10-20。本轮完成三件事：精确取证四个源码包、移除未使用的 `sharp`/libvips、由维护者决定关闭剩余两项 MIT 归属。**源码和镜像发行门禁现均已通过**；六组镜像于 2026-10-21 由维护者 QooIM 带保留签署。

## 结论先行

- `pnpm release:check`：**退出 0**。`@better-auth/utils@0.5.0` 与 `client-only@0.0.1` 已作为维护者决定记录，通知文本进入 `THIRD-PARTY-NOTICES.txt`。
- `pnpm release:check:image`：**退出 0**。六组均已带保留签署，其中 `next-swc` 明确接受“没有逐 crate 通知”的风险。
- `sharp` / `@img/sharp-libvips` 不再安装、不再进入锁文件、不再进入应用镜像；这是**不分发**，不是对 libvips 的许可结论。
- 正式品牌已定为 **Qoo.IM Directory**；域名和公开仓库名待定。
- 真实 GitHub/Google 登录仍留到上线前用凭据实测。

## 两项 MIT 归属决定

两个包都用 registry 元数据、SRI 校验后的精确 tarball、文件清单摘要固定；证据只记录“发布物里有什么”，归属判断由维护者作出并留痕。

| 包 | 精确发布物事实 | 维护者决定 | 通知文件 |
| --- | --- | --- | --- |
| `@better-auth/utils@0.5.0` | 58 个文件、18,017 字节；tarball 无 LICENSE/COPYING/NOTICE。发布修订 `f03c1c76` 根目录无许可文件；两天后提交 `ef522888b7b2` 新增 MIT 正文，版权行为 `2024 - present, Bereket Engida`。 | 接受 npm 元数据的 MIT 声明，并采用作者后来发布的 MIT 正文作为分发通知；不声称 0.5.0 tarball 内含该文件。 | [better-auth-utils-0.5.0.txt](../third-party/licenses/better-auth-utils-0.5.0.txt) |
| `client-only@0.0.1` | 3 个文件、481 字节；只有空 `index.js`、抛错 `error.js` 和声明 MIT 的 `package.json`；无版权行、无 repository。发布者 `sebmarkbage`，homepage `reactjs.org`，bugs 指向 `facebook/react`。 | 接受为 React/Meta 的 MIT 归属，随附 React 18.2 的 MIT 正文；不声称该 tarball 内含版权行。 | [client-only-0.0.1.txt](../third-party/licenses/client-only-0.0.1.txt) |

`third-party/review.json` 记录了 `packageJsonSha256`、registry integrity、来源 URL、文件摘要和决定说明。`manualLicenseReview` 为空；这不等于“这两个发布物本身带完整通知”，而是“维护者已决定按 MIT 归属分发并保留依据”。

### client-only 能不能替换

技术上可以：它只是三文件标记包，可以自建同行为本地包，或用构建别名替换。但这会引入 pnpm override/本地包解析、RSC `react-server` 条件或 webpack 别名，改变依赖图和发布检查边界。当前选择是维护者归属决定，风险最小；如果以后要求“完全不含该依赖”，再单独做替换方案并重跑全量验收。

## sharp / libvips 为什么可以移除

- 代码库没有 `next/image`、`next/og`、`ImageResponse` 或 `sharp` 调用；`sharp` 只是 Next 的 `optionalDependencies`。
- `package.json` 使用 `pnpm.ignoredOptionalDependencies: ["sharp"]`；重新安装并 `pnpm prune` 后，`sharp` 与四个 `@img/sharp*` 目录消失，锁文件不再包含 sharp。
- `next.config.mjs` 设置 `images:{unoptimized:true}`；以后即使使用 `next/image` 也按原图输出，不会隐式要求 sharp。
- 重建镜像：70 个应用包、88 个 Debian 包、172 份许可/版权文件、3 个原生文件（esbuild + 两个 SWC），无 sharp/libvips。
- 之前的 28 组件、105 条通知候选、[组件许可矩阵](../third-party/component-license-matrix.json)和源码归档保留为历史证据；重新引入 sharp 时必须重新打开。

## 镜像审查状态

证据已生成并绑定到 `third-party/image-review.json`。2026-10-21 维护者 QooIM 按[决定卡](IMAGE-DECISION-CARDS.md)带保留签署六组。`next-swc` 因发布物没有 Cargo.lock、无法取得逐 crate 通知，按 option B 明确接受该风险。六组的保留项写在各自 `detail` 中，不能读成“无保留通过”。

## 验证

| 命令 | 结果 |
| --- | --- |
| `pnpm release:check` | 退出 0，源码通知清单完整 |
| `pnpm release:check:image` | 退出 0，六组带保留签署 |
| `pnpm test:release` | 69/69 |
| 全量 P0–P5 + Docker | 2026-10-20 通过，见 [本地验收记录](ACCEPTANCE-20261020.md) |

## 复现

```bash
node scripts/preflight.mjs
pnpm release:check
pnpm release:check:image
```

精确包级证据仍可用 `node scripts/source-license-evidence.mjs` 重新采集；镜像证据用 `node scripts/image-license-evidence.mjs` 重新生成。任何依赖、锁文件、镜像或平台变化后，都必须重新取证并重跑门禁。
