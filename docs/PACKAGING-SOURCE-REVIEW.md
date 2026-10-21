# 固定打包工作树与构建环境边界 Review

日期：2026-10-19。延续[源码输入归档 Review](SOURCE-DELIVERY-REVIEW.md)，补齐 sharp-libvips 1.3.4 的固定打包工作树和辅助文件，扩展独立离线材料包。四项包级许可缺口和七组镜像审查仍未放行。

## 取得与逐文件核对

取得 [官方 codeload 固定提交归档](https://codeload.github.com/lovell/sharp-libvips/tar.gz/ebb95f8add54eee8bed840e3fb587e4cbec857d7)，24,490 字节，SHA-256 为 `65fdb633c2d97626352a3771b7a0ce30b6a89af03d2a1238491c8b068e6b8dad`。归档 PAX comment 与固定提交一致，未使用主分支或版本最新值代替。

依据已保留的官方打包 commit API 元数据，根 Git tree 为 `fbab6e23a0fd10b108e47997f40d9d4113b4a1a4`。从 [该精确树对象 API](https://api.github.com/repos/lovell/sharp-libvips/git/trees/fbab6e23a0fd10b108e47997f40d9d4113b4a1a4?recursive=1) 取得未截断的递归树，逐一重建 Git 目录对象，并核对全部普通文件的 blob、大小及可执行位。

首次按提交定位取得的 tree 响应，其 sha 与 commit 元数据中的 tree 对象不同，未将其直接当作匹配证据；随后改用精确 tree 对象地址，全部目录和文件对象均匹配。原始首次响应留本地，公开材料保留用于核对的精确对象响应。Git 对象 SHA-1 只用于对象格式对应，原始材料同时记录 SHA-256，不代表发布者签名验证。

[完整材料索引](../third-party/packaging-source/collection.json) 保留全部 63 个普通文件、95,376 字节，包括工作流、npm 平台包元数据、各平台 Dockerfile、CMake/Meson 配置、包装器和脚本。原始可执行位记录在索引中；公开材料统一以内容摘要 `.txt` 保存，不按上游成员路径展开或赋予执行权限。

原先单独保留的 posix 配方、versions.properties、THIRD-PARTY-NOTICES.md 和 Apache LICENSE 与完整树中对应文件逐字节相同，来源链没有被新材料替换。两次独立离线采集的索引和原始材料一致。

## 两种 ARM64 平台的已知输入

| 目标 | 打包目录 | 工作树包含的配置 | 尚未固定的环境 |
| --- | --- | --- | --- |
| Linux glibc ARM64 | platforms/linux-arm64v8 | Dockerfile、Toolchain.cmake、meson.ini、aarch64-linux-gnu-pkgconf | Rocky 标签没有 digest，dnf update/install 取当时仓库版本 |
| Linux musl ARM64 | platforms/linuxmusl-arm64v8 | Dockerfile、Toolchain.cmake、meson.ini | Alpine 3.20 标签没有 digest，apk update/upgrade/install 取当时仓库版本 |

两个 Dockerfile 都从 rustup 网络脚本安装 nightly；cargo-c 未指定精确版本，Meson 等构建工具也没有完整版本锁。`--locked` 约束所选 cargo-c 的依赖解析，不能单凭它推定选中的 cargo-c 版本或历史 nightly 已固定。没有安装这些工具、拉取上游基础镜像或运行上游 Dockerfile。

固定工作树现已保留，但实际历史容器镜像、包仓库状态、编译器/链接器版本、nightly、sysroot 和构建日志没有因此自动取得。已知文件配置不等于已捕获环境，更不等于二进制重建匹配。

## Review 修复与导出约束

新增三条发行回归在旧检查中均缺少预期拒绝：完整打包材料缺失、辅助文件改写、漏项、Git 对象不符或历史范围被提升，旧实现仍接受。现在[校验模块](../scripts/packaging-source.mjs)接入实际源码导出的根目录和复制后副本，要求固定打包材料完整存在，并核对：

- 官方打包 commit 快照与根 tree 身份、递归树未截断、目录 Git 对象重建结果。
- 全部 63 个文件的原始成员名、Git 路径、模式、blob、SHA-256、大小及总计。
- 旧四份独立材料与完整树中的对应文件相同，维护采集器摘要不漂移。
- 拒绝目录穿越、链接、未支持的 Git 模式、文件/目录遗漏、摘要变动及历史构建或签名认证冒认。

新增 [Python 维护采集器](../scripts/collect-packaging-source.py) 从已取得的归档、树对象 JSON 和已绑定的 commit 快照离线采集，不执行源码。归档最多 8 MiB、解压总量最多 8 MiB、最多 2,000 成员，普通文件最多 2 MiB；使用已读取的同一归档字节核对，路径不会成为输出路径。失败不写成功 collection.json；输出目录须不存在。

独立原生输入归档工具也新增 packaging-archive 类别及必需参数，原始固定归档放入 sources/packaging.tar.gz。新增回归先确认旧类别检查拒绝，再实现支持；不能仅保留已知配置碎片而漏掉完整原始工作树。六类交付缺口中的环境项现明确为“固定打包树已保留；历史工具链、sysroot 与环境仍未捕获”。材料包仍保持未完成范围，不自动进入公开下载接口。

## 维护命令

需要 Python 3.11+、项目使用的 Node 24，应用及 Docker 不新增依赖。先按索引中的固定官方来源只读取回原始归档和精确树 JSON，再执行：

```bash
python3 -B scripts/collect-packaging-source.py third-party/libvips-source-review.json .local/NEW-packaging.tar.gz .local/NEW-packaging-tree.json .local/NEW-packaging-evidence
python3 -B scripts/native-source-bundle.py .local/NEW-native/archives .local/NEW-crates/archives .local/NEW-gvdb.tar.gz .local/NEW-native-inputs.tar --packaging-archive .local/NEW-packaging.tar.gz
python3 -B -m unittest discover -s tests/p5 -p 'test_*.py'
pnpm test:release
```

两条维护命令不联网、不安装、不执行上游构建代码。输入或 metadata 不符时须排查具体来源，不能为了通过检查盲目重算索引摘要。

## 验证与后续

本轮发行回归 62 项、Python 维护回归 65 项、P5 运维与源码下载回归 11 项均正常退出 0，共 138 项不同测试。生产 build 和随后顺序 check 正常退出 0；严格源码检查仍按原四项包级缺口退出 1，镜像检查仍按原四项加七组范围退出 1，没有将阻挡计为通过。

两份最终独立材料包逐字节相同，包含 387 个原始归档和 867 份证据/维护脚本，共 1,254 个有效载荷文件、206,483,480 字节，tar 为 207,790,080 字节。SHA-256 为 `ac03901c208d6a8219e222fc6a15b5e19c153ab034dd61f31ff32cf3f7c37145`。成员摘要、大小及固定归档元数据均核对通过。

既有不可变镜像使用本轮探针复查，仍为 78 个应用包、88 个系统包、180 条通知、7 个原生候选文件，无扫描告警；公开采集器摘要已同步。未使用本轮源码重建发行镜像，未复跑容量、Docker 整体验收或真实 OAuth。

源码候选使用 `.local/packaging-review-20261019`，最终综合核对记录使用 `.local/packaging-proof-20261019.json`。独立材料包为 `.local/packaging-native-inputs-final-20261019.tar`，对应检查记录为 `.local/packaging-payload-proof-20261019.json`，本轮日志使用 `.local/packaging-*-20261019.log`。

下一步优先确定可复核构建环境的固定策略与实际版本证据，仍须保留无法恢复的历史差异，不把当前重新安装当作历史复现。品牌及真实 GitHub/Google 应用联调未完成；旧站/生产未改，未公开发布。

后续已保存环境声明与历史 CI 元数据，并制定今后固定基线的材料要求，见 [原生环境 Review](NATIVE-ENVIRONMENT-REVIEW.md)；历史容器内版本仍未取得，没有把 runner 标签当作容器环境。
