# 原生源码输入归档与交付边界 Review

日期：2026-10-19。延续[可变输入 Review](MUTABLE-INPUTS-REVIEW.md)，将之前只保存在本地缓存的原始源归档做成可核对的独立材料包，同时保留完整交付仍未验证的边界。四项包级许可缺口和七组镜像审查没有放行。

## 原来的缺口与本轮产物

应用的源码下载包包含项目源码、来源索引、原始通知及若干源码证据，但此前不包含 28 个顶层组件、357 个 registry crate 和 gvdb 的完整原始压缩归档。不能把通知或来源链接当作这些归档已经交付。

新增 [离线归档工具](../../scripts/native-source-bundle.py)，读取已保留归档和现有审查索引，生成独立、未压缩的 tar。上游原始归档按原字节放入，不展开、不执行、不应用补丁；内层组件文件虽统一命名 `.tar`，仍保留原来的实际压缩格式。

| 路径 | 内容 | 数量 |
| --- | --- | --- |
| sources/native/ | 已留存的顶层原生组件原始归档 | 28 |
| sources/crates/ | 原始 Cargo.lock 的全部 registry crate 原归档 | 357 |
| sources/gvdb.tar.gz | wrap 指向的固定提交原归档 | 1 |
| evidence/ | 当前 third-party 材料与维护脚本 | 807 |
| NATIVE-SOURCE-MANIFEST.json | 逐文件路径、类别、SHA-256、字节数与未完成项 | 1 |

有效载荷共 1,193 个文件、206,293,434 字节，不含清单自身和 tar 头/填充。archive 内不写入本机缓存绝对路径。应用源码不在这个独立材料包中，须与项目的源码候选分开核对；原始 npm 二进制包、完整打包工作树、系统镜像、工具链和 sysroot 也不包含在内。

该归档只在本地生成，未接入公开下载接口或上传。现有应用源码下载的范围没有因此自动扩展，也没有宣称已经满足完整对应源码交付。

## 尚未完成的六类核对

1. 已声明组件之外的完整原生嵌套依赖图。
2. 历史最终 Cargo.lock 和可变网络响应的精确原文。
3. 将原始补丁、配方中的行内修改应用到源树并核对结果。
4. 平台条件、实际二进制链接范围和源代码对应关系。
5. 完整打包辅助文件、工具链、sysroot 及构建环境。
6. 通知适用性、源码交付要求及整体分发审查。

这些是工程证据清单，不是许可义务已经完成的结论。原始锁中的 357 个 crate 不等于实际链接图，当前离线候选解析也不等于历史构建。后续应先补齐固定打包工作树和重建环境，再判断哪些输入能重复取得、哪些历史差异必须保留未知。不能仅靠重新计算摘要关闭这些待办。

## Review 与失败路径

旧通知校验只检查最终 LICENSE 文件是否普通文件，没有检查父目录：把 licenses 目录换成指向项目外的符号链接，同样内容仍被接受。新增回归在旧代码确认缺少预期拒绝，再补 realpath 检查。现在离线通知盘点也拒绝经过父级链接读取，不依赖源码复制阶段另行发现。

新归档工具还在实际 386 个归档集成时发现五个合法 crate 版本包含 `+` 构建元数据，过窄的路径规则会误拒绝。新增失败回归后保留这些原始文件名中的加号，穿越、绝对路径、重名和非受控字符仍拒绝。

工具先调用现有 `verifyNativeSourceEvidence`，捕获并核对材料快照，再根据已绑定索引定位源归档。拷贝过程中对真正写入 tar 的字节计算摘要和数量，避免校验一次后重开路径却归档其他内容。拒绝输入文件或其父级符号链接、特殊文件、内容/大小不符、缺失输入、路径穿越、重复输出名和超过预算的清单。

最多 4,000 个文件，总有效载荷最多 512 MiB；单个原生归档 96 MiB、crate 32 MiB、gvdb 8 MiB、证据文件 2 MiB。固定 tar 元数据与排序保证相同输入产生相同归档。先写私有临时文件，全部成功后使用同目录硬链接原子创建目标，不覆盖既有或竞争中出现的文件；失败清理自己的临时文件。该工具面向当前 Linux 本地文件系统，不承诺断电持久性或跨文件系统发布。

## 本地维护

需要 Node 24 和 Python 3.11+ 标准库，应用及 Docker 不增加依赖。现有节点版本可通过 PATH 选择；工具只执行可信项目的校验代码，不执行归档中的源代码或构建脚本。命令不联网、不安装工具或依赖。

```bash
python3 -B scripts/native-source-bundle.py .local/NEW-native/archives .local/NEW-crates/archives .local/NEW-gvdb.tar.gz .local/NEW-native-source-inputs.tar --packaging-archive .local/NEW-packaging.tar.gz
python3 -B -m unittest discover -s tests/p5 -p 'test_*.py'
pnpm test:release
```

输出路径必须不存在。缺少任一原归档时须先按已记录来源取得并核对，不能自动跳过或用最新版本补齐。清单将 not-assessed、historicalBuildVerified=false、sourceCodeExecuted=false、patchesApplied=false 和上述缺口一并带入产物。

## 本轮验证与后续

本轮发行回归 59 项、Python 维护回归 58 项、P5 运维与源码下载回归 11 项均正常退出 0，共 128 项不同测试。生产 build 和随后顺序 check 退出 0；严格源码/镜像检查仍按原四项/原四项加七组范围退出 1，没有放宽或将阻挡计为通过。

两次独立材料归档逐字节相同，tar 大小 207,534,080 字节，SHA-256 为 `42c299b67780fa7d30eded371bf83bd98393e081a8fde8ed5112ffb41db6405b`，所有成员的原始摘要、大小及固定元数据均核对通过。最终应用源码候选使用 `.local/source-delivery-review-20261019`，综合核对记录使用 `.local/source-delivery-proof-20261019.json`，本轮日志使用 `.local/source-delivery-*-20261019.log`。未复跑镜像探针、镜像重建、容量或真实 OAuth。

原生输入归档为 `.local/native-source-inputs-20261019.tar`，材料核对记录为 `.local/source-delivery-payload-proof-20261019.json`。下一步优先补齐固定打包工作树和可复核构建环境；品牌及真实 GitHub/Google 应用联调仍待完成。旧站和生产未改，未公开发布。

后续版本已补齐固定打包工作树，归档命令新增必需的 `--packaging-archive` 参数，上方命令已同步；本文原始验证计数保留当轮范围，最新材料和边界见 [打包工作树 Review](PACKAGING-SOURCE-REVIEW.md)。
