# libvips来源与原生盘点完整性 Review

日期：2026-10-19。本轮继续开源发行收尾，固定精确发布包的构建/源码定位证据，修复原生盘点遗漏。没有升级或替换依赖，没有关闭尚未证实的许可义务。

## 精确发布包与构建依据

从npm registry取得两个sharp-libvips 1.3.4平台包的元数据及归档，逐字节验证SHA-512 SRI与锁文件记录一致。两个归档各6个文件的摘要均与已安装包一致，库文件摘要与上轮镜像盘点相符。仅核对元数据和内容完整性，没有宣称完成npm发布签名或provenance签名验证。

两包gitHead均指向构建仓库 [ebb95f8](https://github.com/lovell/sharp-libvips/tree/ebb95f8add54eee8bed840e3fb587e4cbec857d7)。固定该修订的posix构建脚本、版本声明、第三方许可链接表及打包代码的Apache许可证原文，见 [来源清单](../../third-party/libvips-source-review.json) 和 [保留的脚本](../../third-party/sources/sharp-libvips-ebb95f8/build-posix.sh)。这些文件只作为审查材料，不会被构建脚本执行。

28项版本声明均与固定修订版本表一致。清单记录28个源码归档定位URL、5个外部补丁和13条sed源码修改。已取得 [libvips 8.18.7源归档](https://github.com/libvips/libvips/releases/download/v8.18.7/vips-8.18.7.tar.xz)，大小25,425,084字节、SHA-256为 `5baaead3b0bb20ffdb9e9ff09aa9fda08620923df77b63b436654cb5e0b3bf94`；提取的 [LGPL许可正文](../../third-party/licenses/libvips-8.18.7.txt) 连同归档成员名、归档和文本摘要一起记录。五份补丁均已取得并记录摘要，原始下载材料保留在本地，不直接混入应用源码包。

这只推进了来源和材料核查。源归档尚未按全部修改重建并核对分发二进制，不能据版本相同就宣称完整对应源码已交付。

## Review发现的证据边界

- versions.json列的是构建版本声明，不是已链接组件检测结果。proxy-libintl在该脚本中仅针对musl或macOS构建，但glibc包的声明表也有它；highway还受WITHOUT_HIGHWAY开关控制。清单保留配方条件，实际二进制包含关系不作断言。
- 打包脚本的第三方通知表来自main，是可变引用；固定修订中的表也只是许可名称/链接，不是所有组件的原始版权与许可全文。
- 五份补丁中libultrahdr PR383是可变引用。当前取得的快照不等于历史发布时的输入，须补历史依据。另有行内修改，不能只提供原版上游源码。
- 27项其他组件的源码归档及原始通知、Rust传递依赖、完整工具链/构建输入与对应源码提供方式仍待核查。没有把打包脚本Apache许可或单份libvips LGPL正文当作整个库的许可通知。

因此四项包级缺口与七组镜像审查仍保持未解决。原生来源清单始终标记incomplete，严格检查不会因新增材料自动放行。

## 盘点工具修复

原生扫描原先忽略文件链接和WASM，到达深度上限也会安静返回，可能产生没有警告的残缺清单。把扫描逻辑提取为可测试函数后，三个新用例在原行为上失败，原有15项通过。

现在跟随包内库文件链接并记录相对目标；拒绝读取逃逸包目录的链接，坏链接产生警告。深度截断产生警告，WASM纳入候选文件摘要。目录循环按已访问真实路径终止，node_modules仍交由逐包枚举，不从单个包递归穿透依赖。扫描范围仍是选定原生包及受限深度，不声称完整SBOM或ELF链接分析。

盘点输出升级为format 2，libvips字段改为declaredComponents/declaredComponentsSha256，并附非二进制包含证明的说明。[公开采集摘要](../../third-party/native-inventory.json) 已同步；旧format 1本地证据作为历史记录保留。读取盘点文件的脚本应按format分支，不把旧components字段继续解释成实际包含清单。

## 本轮验证与剩余事项

发行测试19项及P5运维/源码下载11项正常退出0，共30项不同回归。发行测试逐项核对固定材料摘要、源码版本表、两个发布包SRI引用、原生文件摘要及不宣称二进制包含的状态。

使用上一轮保留的不可变镜像ID，以本轮采集器重新执行只读断网探针，仍得到78个应用包、88个系统包、180份许可/版权记录及7个原生候选文件摘要，无警告。新记录的采集器、package.json、锁文件及文本摘要已核对；使用既有镜像不代表重建了本轮最终应用镜像，也未启站做Docker整体验收。

生产build及随后顺序check正常退出0。源码与镜像严格检查仍分别按四项包级缺口、四项加七组镜像范围退出1；未将预期阻挡记作通过。最终文档保存后重新生成归档、导出并核对全部文件摘要和公开Markdown链接。没有重复容量、真实OAuth或漏洞审计，没有操作旧站、生产或公开发布。日志 `.local/native-source-{baseline,first,tests,final,p5,inventory,build,check,source-gate,image-gate,bundle,export}.log`；候选为 `.local/native-source-review-20261019`。下一步应继续取得余下组件原始通知与源归档，补Rust及可变补丁的历史依据，再审查完整交付方案。

后续 [原始通知与导出Review](COMPONENT-NOTICES-REVIEW.md) 已取得余下源归档，全部28项归档及105条原始通知候选已记录；本文“剩余27归档”保留为当时进度。通知适用性/完整性、Rust传递依赖、历史补丁与完整源码交付仍未审查完成，不能把采集成功当作许可关闭。

后续 [Rust 锁文件 Review](RUST-LOCK-REVIEW.md) 已登记 librsvg 的原始 Cargo 输入和 366 条锁定记录，仍不代表逐 crate 原始通知或实际编译图审查完成。

后续：2026-10-20 应用不再使用 `next/image`，`sharp` 作为 Next 可选依赖被排除并清理，两个 `sharp-libvips` 平台包不再分发。本文的 28 组件来源与通知证据保留为历史材料，重新引入 `sharp` 时必须重新打开。见 [源码许可与镜像证据推进 Review](../SOURCE-LICENSE-DECISIONS.md)。
