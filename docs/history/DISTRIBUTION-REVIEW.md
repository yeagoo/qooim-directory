> 当前状态（2026-10-21）：六组镜像已带保留签署，镜像门禁已通过；本文下面“仍 pending”的描述是当时记录。

# 镜像分发清单与发行门槛 Review

日期：2026-10-18。本轮推进独立开源的发行收尾，不新增业务功能，不公开发布。AGPL-3.0-only选择保持不变。

## 许可复核

原四项包级缺口仍未关闭。utils发布源修订的LICENSE仍无法取得，不能把后来主分支许可无条件用于该发布版本。client-only的[上游讨论](https://github.com/vercel/next.js/discussions/99484)尚未得到确认，回复中的Meta/Vercel归属互相矛盾，不能据此制造通知。libvips两个平台包各自的README和versions.json仍列出28项底层组件，逐项通知和准确对应源码有待核查；打包脚本的Apache许可证不能替代它们。精确版本和已有来源证据见 [上一轮许可Review](RELEASE-REVIEW.md)。

本轮没有联系上游，也没有用“声明MIT”替代缺失通知，没有升级、替换或删除依赖来绕过问题。

## 修复与工具

新增回归在旧代码上确认两处通知发现错误：空白LICENSE被算成有效通知；README兜底跟随符号链接，可能读取项目外文件，且没有大小上限。现在只采纳非空的普通通知文件；README兜底同样要求普通文件及小于2 MiB，避免越界读取和无界分配。这些检查防止明显误判，不宣称自动判断所有许可文本的法律完整性。

原 `pnpm release:check` 保持源码候选的包级通知门槛。新增 `pnpm release:check:image` 在同一源码检查之外，聚合镜像审查状态。记录见 [image-review.json](../../third-party/image-review.json)：绑定Dockerfile、两个Compose、锁文件和package.json摘要以及目标平台，文件或平台变化必须重新审查；缺少范围、重复范围、无证据地标记完成、证据摘要变化和符号链接均不能通过。

镜像审查状态以image-review.json为唯一记录，原review.json只保留指向它的引用。七组必需范围为Node/基础系统、全局pnpm、Next SWC、esbuild、sharp-libvips、PostgreSQL镜像及可选Caddy演示镜像，目前均保持pending。人工完成记录须有审查者、日期和随源码保存的证据摘要；程序验证记录完整性，不替人证明许可结论。镜像检查通过也不代表品牌、真实OAuth或第三方安全审计完成。

Dockerfile把整个/app与全局pnpm复制到运行镜像，盘点范围包含实际携带的开发依赖；不能只计算package.json里的生产依赖。PostgreSQL与Caddy由Compose直接引用，与应用镜像分开审查，不能遗漏。

## 可复现盘点

```bash
pnpm release:inventory LOCAL_APPLICATION_IMAGE .local/NEW-inventory.json
pnpm release:check
pnpm release:check:image
```

盘点读取本地已存在镜像，以inspect解析出的不可变镜像ID执行。使用独占容器、无网络、只读文件系统、移除capabilities、禁止提权，没有宿主机挂载；不读取应用环境变量，不连接数据库，不启动应用。结束时只清理本次独占容器。输出文件必须不存在，含实际Node/pnpm版本、Debian包版本、Node/OS/包内许可文本及摘要、应用包元数据和原生文件摘要、libvips组件版本。原生文件摘要用于定位二进制，不自动确认其许可或生成对应源码。

输出是采集证据，不是完整SBOM或漏洞报告；全局pnpm内嵌依赖、Go/Rust二进制内含组件与其他镜像仍需继续展开。命令会将NOTICE全文存入本地JSON，文件权限为0600，不自动进入公开源码。盘点没有启动或扫描生产服务。

## 本轮验证

真实本地Docker隔离构建通过，随后以不可变镜像ID采集：实际Node v24.21.0、pnpm 10.11.1，78个应用包、88个Debian系统包、180份许可/版权文件记录和7个原生文件摘要。两个libvips平台包各有28项组件版本。应用镜像包数量与宿主机86项安装树不同，按实际镜像记录，不混用。可公开审查的 [原生组件采集摘要](../../third-party/native-inventory.json) 保留镜像ID、采集器摘要、镜像内源码包摘要、版本及原生文件摘要；未据盘点关闭任何许可范围。

采集器核对自身摘要、镜像package.json/锁文件摘要、全部180份文本摘要和两个组件表，真实隔离容器采集无警告。该镜像在最终文档/平台门槛完善之前构建，采集器由当前宿主机脚本注入执行；其归档摘要与最后源码候选分别保留，不宣称它就是最终待发行镜像。完整文本证据位于 `.local/distribution-inventory-final-20261018.json`，未自动对外分发。

原代码新增两项回归均失败（原有10项通过）；最终发行15项和P5运维/下载11项正常退出0，共26项不同回归。实际执行包含证据篡改、符号链接、空许可、超大README、漏掉审查范围和平台/构建输入变化。生产build及随后顺序check正常退出0；源码与镜像严格检查均按未解决项退出1，分别列出4项包级缺口、4项加7组镜像待审范围。没有把预期阻挡记为检查通过。

本轮没有启站做Docker整体验收、重复容量测量或进行漏洞扫描；独立Docker构建和只读盘点不能替代这些验收。日志 `.local/distribution-{baseline,first,tests,final,p5,p5-final,image-build,inventory,inventory-final,inventory-proof,build,check,source-gate,image-gate,bundle,export}.log`，源码候选为 `.local/distribution-review-20261018`。未执行旧站迁移、真实OAuth或生产部署。下一步应根据盘点逐项补充原生组件来源与通知，保持未解决状态可见，而非不断重跑业务功能测试。

后续 [原生来源Review](NATIVE-SOURCE-REVIEW.md) 固定了libvips发布归档、构建脚本及源码/补丁定位依据。版本表只证明声明，并非各平台实际包含28项库；盘点format 2改用declaredComponents字段，同时修复链接/WASM及深度截断遗漏。本页计数保留为当时采集记录，不代表完成许可或对应源码交付。

后续 [原始通知与导出Review](COMPONENT-NOTICES-REVIEW.md) 把原始证据完整性验证接入实际导出，镜像输入绑定补充.dockerignore为六项；本页五项为历史状态。原许可与镜像未决状态不变。

后续：2026-10-20 移除未使用的 `sharp` 后，`sharp-libvips` 不再进入应用镜像，镜像审查范围从七组降为六组；其余范围仍为 pending。见 [源码许可与镜像证据推进 Review](../SOURCE-LICENSE-DECISIONS.md)。

后续（2026-10-20）：源码许可门禁已由维护者归属决定关闭。后续（2026-10-21）：六组镜像已由 QooIM 带保留签署，镜像门禁通过；保留项见 [决定卡](../IMAGE-DECISION-CARDS.md)。
