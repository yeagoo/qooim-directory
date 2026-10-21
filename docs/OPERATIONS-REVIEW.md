# 运维失败路径与源码下载 Review

日期：2026-10-18。范围为独立开源目录中的备份恢复脚本与源码下载；没有修改旧站或生产部署。许可检查仍保留 [上一轮的四项缺口](RELEASE-REVIEW.md)。

## 修复及验证设计

- 源码下载原先每个请求 readFile 整包缓冲。改为同一文件句柄获取长度并按消费需求读取，每次最多 64 KiB，不预读整个归档。正常结束、响应取消和请求 Abort 都释放句柄；归档原子替换不会使响应长度与内容错配。文件缺失或不是普通文件时在响应前失败，由既有错误处理返回 503；未知 Host 仍先返回 404。
- 首次尝试使用 Node 的 Readable.toWeb 桥接，真实取消测试触发 Controller is already closed。最终实现使用 Web Stream 按拉取读取，取消期间正在进行的读取完成后不再 enqueue；没有吞掉该测试异常或增加超时。
- 备份原先关闭文件后即报告成功。现在先 flush 密文，再写入并 flush 清单，最后同步输出目录和父目录；失败沿用只清理本次输出的策略。保留格式 1；没有迁移 SQL、依赖或密钥格式变更。这是文件系统同步流程，不是断电或硬件故障的实验结论。
- 恢复原先仅记录 PostgreSQL 版本，未执行文档的同主版本要求。现在完整认证密文后连接目标维护库读取版本，不匹配时拒绝，尚未创建目标库。测试用有效密钥重新认证版本不同的备份，确保命中版本判断，而非单纯因标签损坏失败；同版本真实恢复和事务失败回滚继续验证。

源码下载回归包括原子替换、512 MiB 稀疏文件的慢消费者读位置检查、取消、Abort、已中断请求、缺失归档及目录输入。Linux `/proc/self/fd` 检查取消后的句柄释放，不用整机 RSS 波动作为通过依据。测试文件本身不写出 512 MiB 数据。相关命令与运维边界见 [P5 操作](P5-OPERATIONS.md)。

API 依据：[Node24 文件流与 flush](https://nodejs.org/docs/latest-v24.x/api/fs.html#fscreatewritestreampath-options)、[文件句柄同步](https://nodejs.org/docs/latest-v24.x/api/fs.html#filehandlesync)。本地以 Node24.18.0 验证，未据当前官网版本升级运行环境。

## 本轮结果

本轮 `pnpm test:p5` 11/11（7项运维、4项下载）、`pnpm test:release` 10/10、`pnpm check` 与生产 `pnpm build` 均正常退出码0。下载回归还检查进行中的读取取消；应用入口验证 Content-Length、后台下载/取消、未知Host404以及POST/HEAD继续405。

`pnpm test:docker` 用本轮源码构建独立镜像，最终退出码0，验证真实HTTPS源码下载的声明长度与实际字节数相等、源码包内容及内部材料排除、空库安装、三站与共享登录、SMTP验证、GitHub候选人工审核冻结发布，以及worker/数据库恢复。自建项目容器和卷由脚本清理，没有重启Docker守护进程。Markdown相对链接检查通过。没有将备份flush流程描述为断电恢复实验。

日志保留于 `.local/operations-review-{check,build,tests,release,docker,gate}.log`；最终源码候选 `.local/operations-review-20261018`。严格 `release:check` 仍退出码1，列出四项未解决许可，这是保留门槛的正确结果。此前容量基线不代表本轮重测；真实 GitHub/Google 联调、正式品牌、完整镜像二进制许可仍未完成。没有公开发布。
