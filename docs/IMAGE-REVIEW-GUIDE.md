# 镜像分发人工审查指南

日期：2026-10-20。`third-party/image-evidence/*.json` 是盘点证据，不是许可结论。六组镜像要由维护者逐组阅读许可、通知和源码义务，再把结论写回 `third-party/image-review.json`。程序只校验 reviewer、日期和证据摘要，不替人判断。

## 一、每组都要回答的六个问题

对镜像里实际出现的每个组件（应用包、系统包、原生二进制、随包脚本）：

1. **是什么版本**：镜像 digest、包名、版本、来源（npm/Debian/Alpine/Go/Rust）是否与证据一致。
2. **适用什么许可**：找到该精确版本的许可正文和版权行，不用相邻版本、主分支或“项目整体许可证”替代。
3. **通知是否随分发提供**：许可正文、版权行、NOTICE 是否进入镜像或随镜像提供的通知文件；放在哪里、以什么形式提供。
4. **源码义务**：LGPL/MPL/GPL 等是否需要对应源码、修改文件、安装信息或书面要约；当前是否满足。
5. **与 AGPL-3.0-only 是否兼容**：MIT/BSD/Apache-2.0/MPL-2.0/LGPL 通常可组合；GPLv2-only 等不兼容情形必须单独判断。这里需要工程判断，必要时咨询法律意见。
6. **有没有遗漏**：未声明许可的包、只有声明没有正文的包、静态链接/内嵌的组件、专利条款、商标/署名要求。

结论只能是“该范围内已核对到什么程度、还缺什么”，不能因为证据文件存在就打勾。

## 二、六组分别看什么

| 范围 | 必须核对 | 常见遗漏 |
| --- | --- | --- |
| `node-base` | Node 二进制版本与 LICENSE；Debian 88 个包的 copyright 与源码获取方式；Node 内含 OpenSSL/V8/ICU 等组件；npm 11.19.0（Artistic-2.0）、corepack（MIT） | 把 `/usr/local/LICENSE` 当成覆盖全部 Node 内含组件；只统计 `package.json` 依赖，漏掉系统包；Debian copyright 存在但未读 |
| `global-pnpm` | pnpm 10.11.1 MIT 正文；82 个随包依赖的许可；67 个带许可文件；15 个缺失已补 12 个精确通知，3 个仍无独立正文；`pnpm.cjs` 捆绑代码范围 | 只看 pnpm 自身 LICENSE；把“补了文件”当成许可结论；忽略打包进单文件的依赖 |
| `next-swc` | `@next/swc-linux-arm64-gnu/musl` 的 MIT 声明与通知；Rust 依赖的实际编译图；原生二进制内的 crate 许可 | 只引用 Next 根 license；把 Rust 锁清单当成逐 crate 通知；忽略静态链接 |
| `esbuild` | esbuild MIT 正文；Go 运行时与静态链接依赖（BSD 等）；`bin/esbuild` 二进制分发 | 只看 esbuild 包 LICENSE，漏 Go 标准库/依赖；把编译后的二进制当作纯 MIT |
| `postgres-image` | 53 个 Alpine 包的许可声明与版权；1 个未声明包；PostgreSQL 许可；Alpine 源码/通知获取方式；镜像内没有许可正文的事实 | 只看 PostgreSQL 项目许可；漏 Alpine 基础包；把“声明”当“正文” |
| `demo-proxy-image` | Caddy Apache-2.0 与 NOTICE；32 个 Alpine 包、11 种声明；Go 依赖；可选镜像是否实际分发 | 漏 Apache NOTICE；只审 Caddy 主程序；把演示镜像当作“不发行所以不用管”（Compose 会拉取） |

每组的具体数量、镜像 digest、包清单摘要、许可文件摘要都在对应的 `third-party/image-evidence/<scope>.json` 里。完整清单在本地 `.local/license-evidence/app-inventory.json`（应用镜像）和采集日志中。

## 三、署名怎么写

在 `third-party/image-review.json` 的对应 scope 中：

```json
{
  "id": "node-base",
  "status": "complete",
  "reviewer": "维护者姓名",
  "reviewedAt": "2026-10-20",
  "detail": "核对范围、结论、仍保留的边界（例如未做二进制链接分析）",
  "evidence": [
    { "file": "third-party/image-evidence/node-base.json", "sha256": "..." }
  ]
}
```

- `reviewer` 必须是实际完成审查的人，不能写“AI”“automated”或占位符。
- `detail` 要写明“确认了什么、没确认什么”，不要只写“已审查”。
- 证据文件变更后，`sha256` 必须更新；否则门禁会报 integrity mismatch。
- 没有读完正文、没有确认源码义务时保持 `pending`，不要为了过门禁改成 `complete`。

## 四、AGPL-3.0-only 的兼容性提示

- MIT、BSD、Apache-2.0、MPL-2.0、LGPL 通常可以与 AGPL 组合分发；仍要履行各自的署名、通知、源码/换库义务。
- Apache-2.0 需要保留 NOTICE（如有）和归属；专利授权条款不能忽略。
- LGPL 动态链接通常需要保留换库权利并提供库源码/书面要约；静态链接义务更重，不能只看“用了动态库”。
- GPLv2-only 与 AGPLv3 不兼容；GPLv3 与 AGPLv3 的组合也有附加条款，需单独判断。
- 这不是法律意见；发行前由维护者决定，必要时咨询专业律师。

## 五、证据的边界

- 盘点只记录镜像里有哪些包/文件/摘要，不做 ELF 链接分析、不证明二进制实际包含哪些库、不做漏洞扫描。
- 包声明“MIT”不等于镜像里已附 MIT 正文；`copyright` 文件存在不等于已核对内容。
- 证据文件不包含完整许可正文（正文在 `.local` 全量清单或上游材料中）；审查时需打开对应文本。
- 通过镜像门禁不等于品牌、真实 OAuth、容量或安全审计完成。

## 六、复现命令

```bash
pnpm release:inventory LOCAL_APPLICATION_IMAGE .local/NEW-inventory.json
node scripts/image-license-evidence.mjs
pnpm release:check:image
```

完整审查流程和发行步骤见 [发行前检查清单](RELEASE-CHECKLIST.md)。
