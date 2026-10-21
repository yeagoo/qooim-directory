# 原生构建环境声明与固定基线策略 Review

日期：2026-10-19。延续[固定打包工作树 Review](PACKAGING-SOURCE-REVIEW.md)，将历史配方声明、CI 任务元数据和实际运行环境分开记录。四项包级许可缺口和七组镜像审查未放行，没有将当前宿主机版本替代历史工具版本。

## 本轮能核对的实际材料

[环境审查索引](../../third-party/native-environment/review.json) 绑定固定打包树中的 build.sh、glibc ARM64 Dockerfile、musl ARM64 Dockerfile，保留 18 条带原始路径、行号和声明内容的观察：基础镜像标签、包仓库操作、rustup 网络脚本、nightly 选择、cargo-c、Python 构建工具和驱动脚本的 --pull。

这些是声明，不是已运行的软件版本。镜像引用写有 digest 也只证明引用语法包含 digest，不能自动推定历史镜像已留存或运行过；显式版本参数也不自动成为已安装版本/已捕获制品。原始源码不改写，实际历史工具版本仍为未取得。

官方 Actions API 本次按固定 head_sha 返回 11 条运行记录，其中两个 CI push 运行对应 main 与 v1.3.4：

| 官方运行 | 分支元数据 | ARM64 目标任务 |
| --- | --- | --- |
| [36315645944](https://github.com/lovell/sharp-libvips/actions/runs/36315645944) | main | build-linux-arm64v8、build-linuxmusl-arm64v8 |
| [36315646015](https://github.com/lovell/sharp-libvips/actions/runs/36315646015) | v1.3.4 | build-linux-arm64v8、build-linuxmusl-arm64v8 |

两份 jobs 响应各有 16 个任务，本轮核对其 run_id、head_sha、分支和 attempt；目标任务的结论和 runner 标签按原字段保留。三份原始官方 API 快照共 205,310 字节，以内容摘要保存。当前 API 结果不当作完整运行历史或发布制品的签名证明，也不据相同提交擅自选定哪一次运行产生了当前 npm 二进制。

目标 runner 标签为 ubuntu-26.04-arm，这是 CI runner 元数据，不能替代 Docker 内的 Rocky/Alpine、编译器、Rust 或 sysroot 版本。本次无认证请求 job 日志接口返回 403，网页也提示登录后看日志；没有取得容器内工具版本、镜像摘要或完整构建日志。不能将访问失败写成日志不存在，也没有使用或索取账号凭据来绕过这个范围。

## Review 修复

三条新增回归在旧导出检查中缺少预期拒绝，确认环境审查索引、声明及 CI 关联尚未被校验。现在 [环境分析与校验模块](../../scripts/native-environment.mjs) 接入工作目录和导出副本的现有校验链：

- 绑定完整打包树、三个原始输入及分析器自身摘要。
- 从原文重新派生声明，防止删掉观察、改写来源行、将声明改成历史已捕获。
- 校验三份官方 API 快照的精确来源、原始摘要、大小及可变标记，拒绝混用提交、任务、run_id、分支或重跑 attempt。
- CI 摘要重新从原文计算，runner 标签保持“报告值”，不转为容器工具版本。
- historicalBuildVerified、historicalEnvironmentCaptured、baselineBuilt 均保持 false；修改派生结论或提升范围会拒绝导出。

另一个失败回归复现了文本分析器将 `RUN echo 'cargo install cargo-c'` 等文本误记为安装命令。现将命令识别约束到声明的命令起始位置，跳过注释，不把 echo 中的命令名记为安装。分析器针对上述已验证的三个输入及其已知写法，不是任意 shell/Dockerfile 的完整语义解释器；不识别的新写法也不会让缺口自动变成已完成。

## 新基线的固定策略

以后新建可复核基线时，采用独立的 baselineId 和独立构建记录。历史声明只作为来源参考，新基线的每一个实际值都由构建材料或实测记录填入；在完成前不填写推测版本。

| 项目 | 新基线必须保留的具体材料 |
| --- | --- |
| 源码输入 | 固定打包提交、387 原始归档清单、补丁与行内修改后的源树摘要、最终 Cargo.lock |
| 平台镜像 | 每个目标架构的实际 manifest digest、对应镜像留存位置及摘要 |
| OS 依赖 | 包仓库快照定位、实际安装包及版本清单、必要制品摘要；不再依赖未记录的 update/upgrade 结果 |
| Rust / cargo-c | 精确 Rust 工具链、分发 manifest/组件摘要、rustup 脚本原文及摘要、cargo-c 选定版本和依赖锁 |
| Python 构建工具 | 精确工具版本、解析依赖及安装制品哈希，不能只记录 pip/pipx 命令成功 |
| 运行与输出 | 编译器/链接器/工具版本输出、关键环境变量白名单、命令/构建日志、输出二进制摘要和第二次独立构建比较 |

保留上游原始 Dockerfile，在单独的基线配方中做固定改造，修改本身进入清单。不要覆盖原配方来消除历史未知，也不要把新构建成功改名为历史二进制已复现。先使新基线本身可复核，再单独评估与旧二进制的差异。本轮尚未选择或安装新工具版本，也未构建这个新 builder 基线。

## 离线维护

需要项目使用的 Node 24，无新增应用依赖。将索引中三个官方 sourceUrl 的原始 JSON 只读保留为 runs.raw、jobs-36315645944.raw、jobs-36315646015.raw，再运行：

```bash
node scripts/native-environment.mjs collect .local/NEW-ci-responses .local/NEW-environment-review
pnpm test:release
pnpm source:export .local/NEW-source-review
```

采集命令离线验证已有固定打包材料与 API 快照，不执行上游构建、网络安装脚本或 Docker。每个输入最多 2 MiB，拒绝链接和路径越界，输出目录必须不存在；失败不写成功 review.json，写入中断可保留私有目录供排查。再次采集不等于再次访问上游，也不扩大材料原本的证明范围。

## 验证与后续

本轮发行回归 69 项、Python 维护回归 65 项、P5 运维与源码下载回归 11 项均正常退出 0，共 145 项不同测试。生产 build 与随后顺序 check 正常退出 0；严格源码/镜像检查仍按原四项/原四项加七组范围退出 1，没有把阻挡计为通过。

两次环境离线采集的索引与原文一致；两份最终材料包也逐字节相同，包含 387 个原始归档和 872 份证据/维护脚本，共 1,259 个有效文件、206,711,997 字节，tar 为 208,025,600 字节。材料包 SHA-256 为 `e89e4cfb1c8aa51516b0becbfc23317cb9d7ba36fe0a1924d1bcfc0edba9dc9f`，全成员摘要、大小及固定元数据通过。

既有不可变镜像以本轮探针复查，仍为 78 个应用包、88 个系统包、180 条通知和 7 个原生候选文件，无扫描告警，公开 collector 摘要已同步。未用本轮源码重建镜像、未复跑 Docker 整体验收、容量或真实 OAuth。

源码候选使用 `.local/environment-review-20261019`，综合核对记录使用 `.local/environment-proof-20261019.json`。材料包为 `.local/environment-native-inputs-20261019.tar`，对应核对记录为 `.local/environment-payload-proof-20261019.json`，本轮日志使用 `.local/environment-*-20261019.log`。

后续若取得有明确来源的历史构建日志/制品，可在既有未知项下增补证据；若建设新基线，则按上表记录实测值。品牌和真实 GitHub/Google 应用联调仍未完成；旧站/生产未改，未公开发布。
