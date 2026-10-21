# 优先 crate 精确来源与许可材料 Review

日期：2026-10-19。继续核查离线候选集合中的 mutants 和 selectors，取得其固定提交的源文件匹配依据及许可材料，并修复导出 HTTPS URL 校验遗漏。四项包级许可待办和七组镜像审查没有放行。

## 原始来源与逐文件匹配

从已通过原始 Cargo.lock checksum 的两个 crate 中取得 `.cargo_vcs_info.json` 和 Cargo.toml。按原始仓库 URL、40 位提交和子目录访问固定提交，未用 main/最新版本替换：

| 包 | 仓库与提交 | 子目录 | 匹配普通文件 |
| --- | --- | --- | --- |
| mutants 0.0.4 | sourcefrog/cargo-mutants，14011d08c42a7cd368698fe28f77eb4cd0b65bf0 | mutants_attrs | 5 |
| selectors 0.40.0 | servo/stylo，67faaab3ff7aa66780ec1d0f51ca47e177b812d3 | selectors | 19 |

共 24 个普通文件与原始 crate 逐字节相同，包括所有随包源码、README、变更记录及原始 Cargo.toml。Cargo.toml.orig 对应仓库中的 Cargo.toml；Cargo 自动生成的规范化 Cargo.toml、Cargo.lock、VCS 信息不冒认为仓库同名文件。匹配记录同时保留原始成员名、固定 URL、SHA-256 和完整原始字节，见 [原始材料索引](../../third-party/priority-crates/review.json)。

匹配用于证明这些具体文件与所记录提交一致，不是对发布者签名的验证，也不推定整个工作树干净。原始 VCS 信息按原字节保留；缺少 dirty 字段不自动解释为已验证 clean。没有执行下载的源码或构建脚本。

## 两类许可材料分开记录

mutants 的 [固定提交根 LICENSE](https://raw.githubusercontent.com/sourcefrog/cargo-mutants/14011d08c42a7cd368698fe28f77eb4cd0b65bf0/LICENSE) 是带有原始版权声明的 MIT 许可文件。保留全文，未自行补写或替换版权行；同时将文件按 Git blob 格式计算的对象标识与该固定提交根树中的 LICENSE 对照。这里 SHA-1 仅用于匹配 Git 对象格式，材料本身另有 SHA-256，不当作发布者签名或现代签名验证。

selectors 的原始 Cargo.toml 声明 MPL-2.0，源码头指向 Mozilla 官方 MPL 2.0 页面。已保留 [官方文档](https://www.mozilla.org/en-US/MPL/2.0/) 的原始 HTML 快照，不抽取、改写成自行拼接的许可文本。这份文档是源码头引用的标准许可材料，不能冒认为仓库中存在的 LICENSE 文件；其 URL 不是提交固定引用，明确保留 immutableReference=false 和本次内容摘要。

公开证据共 30 份去重原始材料、352892 字节，包括完整匹配文件、VCS 信息、固定提交根树、MIT 原文和 MPL 官方文档快照。HTTP 原始响应缓存只留本地，公开包仅包含经过索引的材料。网络采集与离线缓存复检的材料及匹配记录一致，Review 调整采集器后只更新其摘要。

这些材料补充了来源和许可文本依据，但不自动完成整个原生包的适用性、通知完整性、修改记录、对应源码或可执行形式分发审查。两个原始 crate 内仍然没有独立通知文件，原 11 项缺独立通知告警继续保留；没有改写原归档、自动生成新的版权归属或更改四项包级发行门槛。

## Review 修复与导出约束

复现了既有原生来源声明只检查 `https://` 前缀的遗漏：将声明、采集记录及摘要一起更新为带用户名/密码的 URL，旧导出验证仍接受。新增回归先确认缺少预期拒绝，再改为解析 URL，要求 HTTPS、非空主机且没有 userinfo；同时覆盖无主机等畸形地址。原来的 28 个真实源 URL 均未改动，Python 下载器与导出校验的边界保持一致。

新增 [维护工具](../../scripts/review-priority-crates.py)，只读取两个精确版本的归档及官方 HTTPS 来源，拒绝路径穿越、规范化重名、链接或特殊成员、不同 checksum、非固定提交、分支名、带凭据仓库地址以及不同源文件。每个文件/响应最多 2 MiB，单包读取总量最多 32 MiB；逐文件下载并发最多 4。失败可以保留本次私有输出供检查，但不会写出成功 review.json；不承诺磁盘故障/断电时整个目录的事务恢复。

实际源码导出在工作目录与复制后副本中，校验输入集合、采集器、全部材料摘要/大小、包与原 VCS 的关系、24 项成员清单、固定源 URL、MIT Git blob 及官方 MPL 文档的可变引用标记。拒绝改用主分支、漏掉匹配文件、篡改提交或声明为许可已完成/发布者已验证；不能把标准文档冒认为原仓库内的不可变许可文件。所有材料状态保持 not-assessed。

同时修正文档计数笔误：[缺通知 crate Review](CRATE-FOLLOWUP-REVIEW.md) 中 selectors 的 17 条补充引用实际是 16 个 Rust 源码前缀加 1 份 README，现已更正；总引用数和原始材料没有变化。

## 维护命令

仅维护工具需要 Python 3.11+ 标准库；应用运行和 Docker 构建不增加依赖。输出目录必须不存在。归档取得方式见 [crate 原始材料 Review](CRATE-NOTICES-REVIEW.md)。

```bash
python3 -B scripts/review-priority-crates.py third-party/libvips-source-review.json .local/NEW-crate-sources/archives .local/NEW-priority-evidence
python3 -B scripts/review-priority-crates.py third-party/libvips-source-review.json .local/NEW-crate-sources/archives .local/NEW-priority-recheck --cache-directory .local/NEW-priority-evidence/cache
python3 -B -m unittest discover -s tests/p5 -p 'test_*.py'
```

第一条读取上游固定提交及官方文档；第二条不联网，仍校验归档、逐文件字节和许可 Git blob。缓存原始响应同样受大小和普通文件限制，修改缓存不能替代重新取得有效材料。官方文档的离线复检只复用已保留快照，不声称它刚刚从网络重新获取。

## 后续边界

下一步继续审查完整原生组件的通知适用性及完整对应源码交付，核对可变历史补丁和真实构建输入。当前材料匹配不是历史最终锁或二进制链接证明，原四项包级与七组镜像待办、品牌及真实 GitHub/Google 应用联调仍保留。旧站及生产未改动，未公开发布。


## 本轮验证记录

发行回归 44 项、Python 维护回归 42 项、P5 运维和源码下载回归 11 项均正常退出 0，共 97 项不同测试，不累计重跑次数。包含固定提交源文件不符、缓存许可被改写、Git 对象不符、分支替换、来源路径/凭据/链接输入、发布者验证冒认及原有导出失败路径。

生产 build 和随后顺序 check 正常退出 0；源码严格检查仍按原四项包级缺口退出 1，镜像严格检查仍按这四项及七组范围退出 1，没有把预期阻挡计作通过。既有不可变镜像使用本轮探针复查，仍为 78 个应用包、88 个系统包、180 条通知及 7 个原生候选文件，无扫描告警；公开采集器摘要已同步。不等同于用本轮源码重建镜像，未复跑 Docker 整体验收、容量或真实 OAuth。

源码候选为 `.local/priority-crates-review-20261019`，最终归档核对记录为 `.local/priority-proof-20261019.json`，日志使用 `.local/priority-*-20261019.log`。原始 HTTP 缓存留在本次独占目录，不进入公开源码候选。
