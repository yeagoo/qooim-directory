# librsvg Rust 锁文件与导出 Review

日期：2026-10-19。继续收敛原生包的来源证据；四项包级许可待办、七组镜像审查状态均未放行。

## 已取得的证据

从上一轮已校验的 librsvg 2.63.2 源归档中，只读取得全部 13 份 Cargo.lock/Cargo.toml，合计 100463 字节，保留原始字节，见 [原始输入与清单](../third-party/rust-lock/inventory.json)。其中根 Cargo.lock 为 86466 字节，SHA-256 为 `e79e2a2735a0b5b151bb4133becd3008223fabedd34a8b787a872edab9854941`。

根锁文件共 366 条记录：357 个 crates.io 注册表包、9 个无 source 的工作区包。清单保留名称、版本、source、注册表原始 checksum 和依赖引用；同名不同版本分别保留，不能按名称去重。清单绑定源归档的 URL、版本、摘要、大小，以及采集器摘要；[原生来源记录](../third-party/libvips-source-review.json) 再绑定清单摘要。

这里的范围是完整根锁文件，不是已编译的目标依赖图。工作区包含 CI、fuzz、bench 等成员；不同目标平台、构建特性及配方对 image/cairo 的修改也会影响实际使用范围。没有下载这 357 个 crate 归档，没有取得其逐包原始通知，没有执行 Cargo、编译或声称它们均被链接进平台二进制。其他原生组件的嵌套依赖、工具链和完整对应源码交付仍需核查。

## 可重复维护与边界

维护工具需要 Python 3.11+ 标准库；应用运行及 Docker 构建不需要 Python。以下两个输出目录必须不存在：

```bash
python3 -B scripts/collect-native-sources.py third-party/libvips-source-review.json .local/NEW-native-sources
python3 -B scripts/inventory-rust-lock.py third-party/libvips-source-review.json .local/NEW-native-sources/archives/rsvg.tar .local/NEW-rust-lock
python3 -B -m unittest discover -s tests/p5 -p 'test_*.py'
```

第一条会下载声明的全部原生源归档；第二条只读已下载的 rsvg 归档，不联网、不执行代码、不解包源树。输出中的证据路径使用固定公开路径，因而与本地输出目录无关。公开输入与清单来自同一已校验归档；本轮在第二个独立目录重跑，并逐字节核对原始 Cargo 文件。

工具先校验归档身份，再遍历全部 tar 成员，所有验证通过后才创建输出。拒绝路径穿越、规范化重名、Cargo 文件链接、损坏输入和覆盖已有目录；限定归档 96 MiB、解包声明总量 2 GiB、成员 100000、单个 Cargo 文件 2 MiB。Review 又补上最多 100 个 Cargo 文件及合计 16 MiB 上限，避免大量小文件导致内存无界增长。锁文件仅接受当前已验证的格式 4、crates.io 来源和工作区记录；出现其他来源必须扩展审查，不能静默跳过。

验证后写出不等于磁盘故障或断电时具备事务恢复能力；输出失败应保留本次目录供检查，重跑使用新目录。

## 实际导出校验

沿用 exportSource 的根目录和复制后副本两次校验。只要声明了 rsvg，就必须提供绑定的 Rust 清单；缺失不会退回旧行为。校验清单与采集器摘要、源归档身份、原始输入摘要和大小、根锁文件及工作区清单存在性、包身份唯一性、来源和 checksum、依赖引用格式及计数。

原始 Cargo 文件仍按普通公开源码文件进入 SOURCE-MANIFEST.json 和归档。新增测试覆盖清单遗漏、原文件变更、编译范围冒认、重复包身份、注册表 checksum 丢失、归档关联改写、原工作区清单遗漏和采集器漂移。测试会使用重新绑定摘要后的畸形清单，避免只测到最外层摘要不符。

这些摘要用于发现输入漂移和副本不一致，不是发布者签名，也不能证明手动重新绑定过的清单与锁文件在语义上相同。重生成及原始材料审查仍是维护流程的一部分，不自动满足许可义务。

## 本轮验证与剩余项

发行回归 26 项、P5 运维和源码下载回归 11 项、Python 归档与 Rust 输入回归 14 项，均正常退出 0，共 51 项不同测试，不累计重跑次数。生产 build 和随后顺序 check 均正常退出 0。源码严格检查仍因四项包级待办退出 1，镜像严格检查仍因这四项及七组镜像审查退出 1，没有把预期阻止发布计作通过。

本轮源码候选目录为 `.local/rust-lock-review-20261019`，日志为 `.local/rust-lock-{release,p5,build,check,source-gate,image-gate,bundle,export}-20261019.log`；归档一致性核对记录使用 `.local/rust-lock-proof-20261019.json`。

对既有不可变镜像使用本轮探针重新盘点：78 个应用包、88 个系统包、180 条通知记录、7 个原生候选文件，无扫描告警；更新公开盘点的采集器摘要。这不是最新源码重新构建镜像，也不是完整链接分析。未重跑 Docker 整体验收、容量或真实 OAuth，未升级依赖、修改旧站或公开发布。

下一步应按锁文件 checksum 获取 crate 原始材料，并结合准确目标、特性和历史构建输入缩小实际适用范围；仍需核对 libultrahdr 历史可变补丁和完整对应源码提供方案。另两项普通包的原始许可来源及品牌、真实 GitHub/Google 应用联调保持待办，见 [发行边界](RELEASE-REVIEW.md) 与 [原生来源](NATIVE-SOURCE-REVIEW.md)。

后续 [crate 原始材料 Review](CRATE-NOTICES-REVIEW.md) 已取得并校验全部 357 个注册表归档，补齐原始清单和通知候选，并修复 UNLICENSE 漏采；其中 11 个包缺少独立通知候选，实际编译范围与适用性仍未确认。本文“未下载”保留为当时进度。
