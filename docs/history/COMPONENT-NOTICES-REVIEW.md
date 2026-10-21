# 原生组件原始通知采集与导出门禁 Review

日期：2026-10-19。本轮取得全部28个声明组件的源归档，保存原始通知候选，并将完整性验证接入实际源码导出。没有把材料取得等同于许可审查或对应源码义务完成。

## 本轮取得的材料

依据上一轮固定构建脚本的精确URL取得全部28个源归档，总计163,232,904字节（包含此前取得的libvips源包）；不自动改用相似版本或备用来源。每项记录版本、原URL、归档大小和SHA-256；这证明本轮取得的内容，不能独自证明标签从未变化或发布时使用了完全相同的源输入。

共105条原始通知候选引用，按内容摘要去重为96份文件，总692,699字节，包含版权、许可、NOTICE、PATENTS和AUTHORS等。链接表见 [采集记录](../../third-party/component-notices.json)，原始字节保存在third-party/component-notices；构建版本及修改依据见 [源审查清单](../../third-party/libvips-source-review.json)。源归档保留于本地 `.local/component-sources-final-20261019/archives`，未把约163 MB归档直接塞进应用源码包。

保留10条告警：归档内COPYING/LICENSE链接不从宿主机读取，空AUTHORS不当作有效通知。GLib等项目的LICENSES目录也纳入原始文本采集，但仍需人工核对链接的归属和范围。收集到的文本只是候选，不保证覆盖嵌套源码的所有版权行、Rust/其他传递依赖、可变补丁历史或最终源码交付方式。

四项包级缺口和七组镜像审查仍保持未解决；collection的licenseClearance为not-assessed，源清单状态为incomplete。没有把这些候选文本直接作为两个libvips npm包的完整许可通知塞入已通过列表。

## 采集工具与Review修复

维护命令（Python 3标准库；不属于应用运行依赖）：

```bash
python3 scripts/collect-native-sources.py third-party/libvips-source-review.json .local/NEW-source-collection
python3 -B -m unittest discover -s tests/p5 -p 'test_native_sources.py'
```

目标目录须不存在。最多4个下载任务，使用HTTPS，限制归档、解包成员与通知体积；只读tar成员，不解包源树，不执行源码或补丁。成员名永远不用于输出路径，通知只写入内容摘要文件名；拒绝越界路径、规范化重名和超限输入。原始字节保留，链接、空文件和下载失败显式记录；失败不会自动换URL或伪称完成。

六项首轮回归有两项失败：恶意后续成员使归档被拒绝时，先前通知已写出；同一成员名的`./`别名也未拒绝。现改为全归档验证后才提交候选文本，并按规范化路径检查重名；并行写共享许可时使用锁，避免把另一任务尚未写完的文件误判为摘要冲突。补充LICENSES目录候选回归后共7项通过。这里是归档内容校验后的提交，不承诺磁盘故障或断电时整个采集目录具备事务恢复能力。

测试导入会产生Python字节码，源码枚举、Git和Docker上下文均排除__pycache__/pyc，避免编译器路径和生成物进入公开包。推荐使用上面的-B测试命令。

## 实际导出门禁

原来的固定源材料摘要主要由回归测试检查。本轮新增verifyNativeSourceEvidence并接入exportSource：构建、bundle、export、源码检查和镜像检查在走源码导出时都验证原始材料；复制结束后还校验导出副本，不能只信工作目录。

校验采集器摘要、28项组件的身份/版本/源URL、声明摘要、归档摘要/大小、通知索引自身的摘要、原始材料文件摘要及每份通知的原始字节。拒绝遗漏、重复、改写、逃逸路径、符号链接、异常大文件和伪造的版本/源归档关联；失败采集可保留为明确的失败记录，但不会计作已采集，更不会计作许可审查通过。

镜像门槛新增绑定.dockerignore，与Dockerfile、两个Compose、锁文件及package.json共六项输入一起检查。新增回归在旧行为上确认改变忽略规则不会使审查失效，现已修复。此前记录的五项输入是历史状态，当前以image-review.json为准。

## 验证范围

最终代码的发行23项、P5运维/源码下载11项、Python采集7项正常退出0，共41项不同回归，不累计中间重跑。既有不可变镜像用本轮采集器重新盘点，仍为78应用包、88系统包、180通知记录和7个原生候选文件摘要，无警告；这不等同于本轮新建应用镜像或完整链接分析。生产build及随后顺序check正常退出0。最终文档保存后重新生成归档、导出并核对全部摘要和公开Markdown链接。源码与镜像严格检查仍按四项包级及四项加七组镜像范围退出1，没有放宽发行条件。日志 `.local/component-source-{baseline,gate-baseline,collection,collection-final,python,python-final,first,tests,final,p5,p5-final,inventory,inventory-final,build,check,source-gate,image-gate,bundle,export}.log`。源码候选为 `.local/component-notices-review-20261019`。

本轮未升级依赖、重建最终应用镜像、启站做Docker整体验收、复测容量或真实OAuth；未修改旧站或生产，未公开发布。仍须审查通知适用性与完整性、Rust传递依赖、历史补丁和完整对应源码提供方案，详见 [原生来源Review](NATIVE-SOURCE-REVIEW.md)。

后续 [Rust 锁文件 Review](RUST-LOCK-REVIEW.md) 已补充 librsvg 的 13 份原始 Cargo 输入和 366 条锁定记录。尚未取得逐 crate 归档/通知或实际编译图，不能据此关闭本页的传递依赖缺口。
