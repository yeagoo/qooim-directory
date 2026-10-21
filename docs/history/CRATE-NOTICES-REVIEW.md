# crate 原始材料与导出 Review

日期：2026-10-19。完成 librsvg 根锁文件中全部注册表 crate 的归档校验及原始材料采集，修复 UNLICENSE 漏采。四项包级许可待办、七组镜像审查状态仍未放行。

## 证据与适用范围

对 [Rust 锁文件清单](../../third-party/rust-lock/inventory.json) 中的 357 个注册表包，取得原始 `.crate` 归档共 38675419 字节，每包 SHA-256 均与原始 Cargo.lock checksum 一致。同时保留各包原始 Cargo.toml、名称/版本、声明许可、原始通知候选及官方下载 URL，见 [采集记录](../../third-party/crate-notices/collection.json)。

下载路径依据 [官方注册表配置](https://index.crates.io/config.json) 与 [Cargo 下载端点规则](https://doc.rust-lang.org/cargo/reference/registry-index.html#download-endpoint)，没有猜测版本或用其他来源的文本替代。取得的原始配置也随证据保存并绑定摘要。归档留在本地维护目录；公开源码候选包含索引、原始清单和通知文本，不包含 38.7 MB 的 crate 源归档。因此不声称完成全部对应源码的交付。

修复后共有 653 条通知候选引用，去重为 207 份通知文本，加上 357 份原始 Cargo.toml，共 564 份原始文本、1529598 字节。9 个无注册表 source 的工作区记录不作为注册表下载任务。没有执行下载内容或 Cargo 构建。

这些是完整锁文件的注册表材料，不是实际链接组件清单。开发、测试、工具、平台和特性条件仍需结合准确的历史构建分析；未验证发布者签名、重现二进制构建或自动判定许可适用性。清单中的 declaredLicense 直接来自原始 Cargo.toml，没有自动选择双许可证分支，也没有把声明当作原始许可正文。

11 个归档没有找到独立通知候选，采集状态为 collected 只表示归档/清单取得成功，仍保留告警：

| 包 | 版本 |
| --- | --- |
| anes | 0.1.6 |
| block | 0.1.6 |
| defmt-parser | 1.0.0 |
| difflib | 0.4.0 |
| malloc_buf | 0.0.6 |
| mutants | 0.0.4 |
| objc-foundation | 0.1.1 |
| objc_id | 0.1.1 |
| selectors | 0.40.0 |
| winapi-i686-pc-windows-gnu | 0.4.0 |
| winapi-x86_64-pc-windows-gnu | 0.4.0 |

这不等于这些包无许可，也不等于已可分发；源码文件头或 README 中的许可材料尚未逐项审查，不臆造版权归属。当前 357 个原始清单均有 license 字段，没有 license-file 声明；未来出现自定义 license-file 时仍须核对其引用的文件，文件名候选扫描不是完整性保证。

## Review 修复与校验

实际检查归档发现 12 个 crate 含 UNLICENSE，但共享采集规则只识别 LICENSE、COPYING 等名称。新增测试先复现遗漏，随后补充 UNLICENSE/UNLICENCE 识别，取得原来漏掉的 12 条引用、1 份共享原始正文。没有自行补写文本。对 357 个 crate 离线复检，仍重新校验完整归档 checksum；28 个原生组件归档也逐项核对原摘要后用新规则复检，原来 105 条引用、96 份文本保持不变，采集器证据已同步更新。

新维护工具先将生成清单与原始 Cargo.lock 重新解析结果比对，拒绝只改生成清单的包集合。下载最终地址须为官方 HTTPS 存储；并发最多 4，单个归档最多 32 MiB，继承现有 tar 成员数、解包体积和通知体积限制。不解包源树、不执行源码，不在 checksum 不符时检查或发布通知。失败记录区分 download-failed、checksum-mismatch、archive-rejected，不能携带成功的 manifest/notice 声明；失败不会被自动换源或视为许可审查完成。

实际 exportSource 在复制前及副本完成后，校验新集合的摘要、三份采集器摘要、原始锁文件关联、注册表配置、完整包集合、checksum、原始 Cargo 清单和每份通知的摘要/大小/路径。拒绝漏项、重项、伪造归档 checksum、越界路径、原始文件变更和采集器漂移。所有记录保持 licenseClearance 为 not-assessed；未发现独立通知的告警不能因导出成功而清除。Review 新增测试先确认原校验会接受已删除的告警，再补充显式约束并通过回归。摘要用于发现漂移，不是发布者签名。

## 维护与重现

仅维护工具需要 Python 3.11+ 标准库，应用与 Docker 构建不增加 Python 依赖。输出目录必须不存在。使用随源码保留的原始注册表配置：

```bash
python3 -B scripts/collect-crate-notices.py third-party/rust-lock/inventory.json third-party/crate-notices/registry-config.json .local/NEW-crate-sources
python3 -B scripts/collect-crate-notices.py third-party/rust-lock/inventory.json third-party/crate-notices/registry-config.json .local/NEW-crate-reinspection --archive-directory .local/NEW-crate-sources/archives
python3 -B -m unittest discover -s tests/p5 -p 'test_*.py'
```

第二条不联网，但不会跳过原始 checksum。失败及部分下载归档保留供本地检查；它们不会被标为 collected。验证后写出不等于磁盘故障或断电时具备完整目录事务恢复能力，重跑须使用新输出目录。

## 验证记录与剩余任务

最终代码的发行回归 31 项、Python 采集回归 24 项、P5 运维和源码下载回归 11 项均正常退出 0，共 66 项不同测试，不累计重跑。包含 checksum 不符时不扫描、不联网离线复检、晚到的路径穿越不发布通知、原始清单身份不符，以及导出遗漏、重复、篡改和失败记录的回归。

生产 build 及随后顺序 check 均正常退出 0。源码严格检查仍因四项包级缺口退出 1，镜像严格检查因这四项加七组镜像审查退出 1；没有放宽门槛或把预期阻止发布计作通过。源码候选目录为 `.local/crate-notices-review-20261019`，归档核对记录为 `.local/crate-proof-20261019.json`；采集、回归、构建和检查日志使用 `.local/crate-*-20261019.log`。

既有不可变镜像重新盘点为 78 个应用包、88 个系统包、180 条通知、7 个原生候选文件，无扫描告警；公开探针摘要已更新。这不是以最终源码重建镜像，没有复测容量、Docker 整体验收或真实 OAuth，没有升级依赖、修改旧站或公开发布。

下一步优先判断这 11 个包及其他锁定记录在实际目标/特性构建中的适用性，再核对精确来源的文件头、README 等原始材料。libultrahdr 历史可变补丁、其他嵌套输入、完整对应源码交付、另两项普通包原始许可来源及镜像范围仍待核查。品牌和真实 GitHub/Google 应用联调也保持待办。

后续 [缺通知 crate Review](CRATE-FOLLOWUP-REVIEW.md) 已保留 8 个包的 27 条 README／源码前缀复核输入，11 项缺独立通知的告警仍在。精确配方执行 cargo update --workspace 的依据也已纳入导出边界；原始锁不等于当时最终构建锁。
