# Rust 离线候选范围与 Review

日期：2026-10-19。基于已经校验的 librsvg 2.63.2 源归档与 357 个 crate，在独立目录验证配方中特性改动后的依赖解析。结果用于安排后续来源审查，不是历史构建、二进制链接或许可完成证明。

## 本轮取得的结果

使用现有 Cargo/Rustc 1.96.0，宿主为 aarch64-unknown-linux-gnu，不安装或升级工具链。宿主单独记录，不能从目标平台推断，构建依赖和过程宏的候选范围也受宿主影响。按精确 Cargo.toml 声明删除 image 的 gif/webp 特性及 cairo-rs 的 pdf/ps 特性，再执行 `cargo update --workspace --offline`。原始锁文件 366 条记录变为 362 条，仅删除 color_quant 1.1.0、gif 0.14.2、image-webp 0.2.4、weezl 0.1.12，没有新增包或改变已有 checksum。

以精确 Meson 调用选择的 librsvg-c 为根，使用 `cargo tree --offline --locked --edges normal,build`，分别保留两个 ARM64 目标和 AVIF 开关的四个情景：

| 目标 | AVIF | 候选包总数 | 注册表包 | 工作区包 |
| --- | --- | --- | --- | --- |
| aarch64-unknown-linux-gnu | 关 | 162 | 160 | 2 |
| aarch64-unknown-linux-gnu | 开 | 179 | 177 | 2 |
| aarch64-unknown-linux-musl | 关 | 162 | 160 | 2 |
| aarch64-unknown-linux-musl | 开 | 179 | 177 | 2 |

完整记录、逐包 checksum 及归一化列表见 [解析证据](../third-party/rust-resolution/resolution.json)。11 个缺独立通知包中，mutants 0.0.4 与 selectors 0.40.0 出现在全部四个候选集合中，后续优先核对它们的原始许可材料及适用义务。其他 9 个包未出现在这些集合中，不能据此关闭它们原有告警或断言它们不在历史二进制中。

四情景保留 AVIF 的两种可能性，因为实际 Meson 自动检测结果尚未取得。normal,build 包含普通依赖、构建依赖和相关过程宏，不等于仅运行时组件。[Cargo 官方说明](https://doc.rust-lang.org/cargo/commands/cargo-tree.html#feature-unification) 也明确 tree 只是接近构建使用的特性统一结果，并不保证与最终编译完全相同。

## 可重现维护与隔离

新增 [离线维护工具](../scripts/resolve-rust-scope.py)，只调用已安装工具链的 version、update 和 tree；不执行 Meson、cargo wrapper、cargo-c、第三方 build.rs、过程宏或源归档脚本，不编译 crate。源码与 vendor 目录只存在于本次私有临时目录，正常退出或异常都会清理；输出目录必须不存在，失败输出不会生成成功的 resolution.json。

```bash
python3 -B scripts/resolve-rust-scope.py third-party/libvips-source-review.json .local/NEW-native-sources/archives/rsvg.tar .local/NEW-crate-sources/archives .local/NEW-rust-scope --cargo /ABSOLUTE/INSTALLED/TOOLCHAIN/bin/cargo
python3 -B -m unittest discover -s tests/p5 -p 'test_*.py'
```

将上述路径换为自己的已校验归档和已有工具链；原始归档取得命令见 [crate 材料 Review](CRATE-NOTICES-REVIEW.md) 和 [原生通知 Review](COMPONENT-NOTICES-REVIEW.md)。这里只读已有材料，不联网。工具链必须使用真实 cargo 二进制及同目录 rustc，不能传 rustup 代理来触发工具链切换或安装。应用运行及 Docker 构建不增加 Rust/Python 依赖。

工具先验证原始输入集合及逐包 checksum，再构造 Cargo 目录源和 checksum 清单；不会借用或更改全局 Cargo 缓存。子进程采用明确的环境变量，指定独立 CARGO_HOME 及真实 Rustc；拒绝临时目录祖先或源工作区的 Cargo 配置，避免继承外部命令设置。解包只写普通文件并设为 0600，不保留可执行位，不跟随归档链接；本轮跳过 7 个非普通成员，均不作为完整源码交付的证明。路径穿越、规范化重名、归档身份不符、异常大成员及未收集的包都会失败。

两次最终独立临时工作区运行取得逐字节相同的解析记录和 11 份归一化材料；特性改写修复前后的这 11 份材料也相同。材料包括 4 份原始 Meson/wrapper 输入、2 份改动后 Cargo.toml、重建的锁文件和 4 份规范化列表，共 140657 字节。原始 Cargo 输出含临时路径的 stderr 只留在本地 local-logs；公开列表保留名称/版本，不保存本机工作路径。Cargo stderr 包含 fuzz 子项目 profile 被忽略的警告，原始日志留在本地，公开记录保留 hasStderr；没有宣称 Cargo 零警告，也没有运行 fuzz。

## Review 修复与实际导出

Review 发现新工具最初使用全局字符串替换：当 image 声明格式变化、同样的特性字串恰在另一个字段中时，会改错字段却宣告成功。新增测试先复现“不抛出预期错误”，现仅在唯一的 image、cairo-rs 声明行执行精确替换；不符合预期的输入直接失败。真实材料重新执行后的 11 份结果与前一次逐字节相同。

实际源码导出沿用复制前和副本两处校验，新增解析证据的输入摘要、采集器、材料集合、情景完整性、原始包身份/checksum、移除记录、规范化列表、命令参数和 11 项缺通知包的集合成员关系。拒绝把当前情景标为已验证历史构建、遗漏 AVIF/目标情景、加入未收集版本、改写优先缺通知包的成员关系、替换成 build 命令或篡改列表文件。所有审查状态保持 not-assessed。

## 明确未完成的范围

本轮没有应用源代码补丁，没有执行 Meson/系统库探测，也没有重现 cargo-c、原发布工具链和平台镜像。原始配方中的其他源码修改、静态链接参数与构建后裁剪仍影响实际二进制。已保存的 reconstructed-Cargo.lock 是本轮当前工具链离线生成的结果，不是发行方历史锁文件；不能只用它重新标记许可证或放行分发。

原四项包级许可缺口、11 项缺独立通知告警及七组镜像审查仍保留。下一步优先审查 mutants/selectors 的精确来源和适用材料，同时继续取得历史构建、完整对应源码及可变补丁依据。品牌与真实 GitHub/Google 应用联调保持待办。旧站及生产未改动，未公开发布。


## 本轮验证记录

发行回归 39 项、Python 维护回归 36 项、P5 运维和源码下载回归 11 项均正常退出 0，共 86 项不同测试，不累计中间重跑。涵盖不受控 Cargo 配置/路径/链接输入、原始归档 checksum、声明行错改、树输出中的未知包及本机路径归一化，以及导出时的范围冒认、宿主遗漏、情景遗漏、成员关系、命令和材料变更。

生产 build 及随后顺序 check 正常退出 0；源码严格检查仍按原四项包级缺口退出 1，镜像严格检查仍按这四项及七组范围退出 1，没有把预期阻挡计作通过。既有不可变镜像复查仍为 78 个应用包、88 个系统包、180 条通知和 7 个原生候选文件，无扫描告警；公开采集器摘要已同步，不等同于用本轮源码重建发行镜像。未复测容量、Docker 整体验收或真实 OAuth。

源码候选为 `.local/rust-scope-review-20261019`，归档核对记录为 `.local/rust-scope-proof-20261019.json`，日志使用 `.local/rust-scope-*-20261019.log`。维护输出中 local-logs 保留失败/警告诊断，不复制到公开材料目录。

后续 [优先 crate 来源 Review](PRIORITY-CRATES-REVIEW.md) 已比对 mutants/selectors 的固定提交，24 个普通文件与原始 crate 相同，并取得 MIT 原文及官方 MPL 文档快照。材料取得没有关闭原始通知告警或整个原生包审查。
