# Qoo.IM Directory 设计文档

更新日期：2026-10-21。P0、P1、P2 已完成，验收证据见各阶段交付记录；P3 已实现模板、认证完善和账号中心显式绑定/解绑，真实 GitHub/Google 账号联调待凭据；P4 已实现 GitHub 项目同步与审核发布；P5 已交付备份恢复、源码归档及容量短基线，完整公开发行仍有真实外部联调、域名/仓库名与容量边界前置项；源码与镜像门禁已通过。

当前背景、开发历史、剩余任务和建议顺序以[项目开发交接总览](PROJECT-HANDOFF.md)为准；可复制给其他模型的提示词见[模型交接提示词](MODEL-HANDOFF-PROMPT.md)。

| 文档 | 唯一职责 |
| --- | --- |
| [账号响应确认 Review](ACCOUNT-RESPONSE-REVIEW.md) | 认证错误恢复、明确确认字段、密码重置token和外部跳转 |
| [读者响应异常恢复 Review](READER-RESPONSE-REVIEW.md) | 代理错误页、HTTP状态保留、未确认写入和只读核对 |
| [目录收藏与共享提示 Review](CATALOG-ACTION-REVIEW.md) | 重复收藏守卫、各读者动作提示归属及写后读取版本 |
| [读者退出交互 Review](READER-SIGNOUT-REVIEW.md) | 退出等待去重、认证错误提示与失败重试 |
| [收藏跨重绘操作 Review](FAVORITE-REDRAW-REVIEW.md) | 按资源保留等待、尾页纠正、独立解锁及自动读取消息归属 |
| [个人投稿历史分页 Review](SUBMISSION-HISTORY-REVIEW.md) | 100条以外历史访问、稳定排序、独立翻页和读取恢复 |
| [读者提交确认 Review](READER-COMMIT-REVIEW.md) | 投稿事件去重、即时确认、只读恢复和交错动作提示归属 |
| [投稿限流时间边界 Review](SUBMISSION-CLOCK-REVIEW.md) | 锁等待后的小时窗口、插入时间及并发额度隔离 |
| [个人写入会话事务 Review](PERSONAL-TRANSACTION-REVIEW.md) | 投稿排队后授权、收藏与撤销提交顺序、锁等待后的会话期限 |
| [主档新版比较 Review](MASTER-DIFF-REVIEW.md) | 已保存草稿优先、首次发布前比较、只读与版本冲突边界 |
| [GitHub 来源与候选交互 Review](GITHUB-UI-REVIEW.md) | 来源写入互斥、成功确认与只读恢复、未提交编辑及候选版本确认 |
| [主档文件导入交互 Review](RESOURCE-IMPORT-REVIEW.md) | 文件执行确认、原位列表刷新、未提交主档保留与编辑版本边界 |
| [配置编辑写入与刷新 Review](CONFIG-EDITOR-REVIEW.md) | 四类写入互斥、成功确认、未提交内容保留、版本确认失效与只读恢复 |
| [建站与总览流程 Review](OVERVIEW-REVIEW.md) | 创建确认、作用域刷新、初始化竞争、等待互斥及账号模式保留 |
| [成员与权限页面 Review](TEAM-PAGE-REVIEW.md) | 添加/授权/撤销/停用的等待互斥、成功确认、密码清理及输入恢复 |
| [后台任务页 Review](TASK-PAGE-REVIEW.md) | 失败资格、等待互斥、重试成功后刷新失败的确认与列表恢复 |
| [账号与任务控制 Review](ACCOUNT-CONTROL-REVIEW.md) | 账号、授权、停用、建站与任务重试的事务权限、审计与并发顺序 |
| [管理写入口 Review](MANAGEMENT-WRITES-REVIEW.md) | 主档、审核、来源/任务和提供方配置的事务权限与批量提交顺序 |
| [事务权限 Review](PERMISSION-TRANSACTION-REVIEW.md) | 发布与停站排队期间撤权、事务授权行锁及配置写入一致性 |
| [账号页面流程 Review](ACCOUNT-FLOW-REVIEW.md) | 自动续接与手动登录归属、迟到响应、失败会话读取和重复提交 |
| [读者页面 Review](READER-PAGE-REVIEW.md) | 收藏语言/分页请求归属、加载重试、投稿后编辑保留及提交与刷新失败区分 |
| [会话绝对有效期 Review](SESSION-EXPIRY-REVIEW.md) | 共用身份授权、组退出来源、原型预览与正式会话到期一致性 |
| [后台任务 Review](WORKER-REVIEW.md) | 任务异常隔离、持久重试、成功心跳及当前源码安装验收 |
| [原生环境与固定基线策略 Review](NATIVE-ENVIRONMENT-REVIEW.md) | 环境声明、历史 CI 关联、runner/容器边界及今后基线的材料要求 |
| [固定打包工作树 Review](PACKAGING-SOURCE-REVIEW.md) | 完整 Git 树、辅助文件、打包原归档及环境未固定边界 |
| [源码输入归档与交付边界 Review](SOURCE-DELIVERY-REVIEW.md) | 386 原始归档、离线材料包、完整交付缺口及通知路径修复 |
| [历史可变输入 Review](MUTABLE-INPUTS-REVIEW.md) | PR 固定提交 diff、通知 Git blob、当前/历史范围及导出约束 |
| [gvdb 嵌套来源 Review](GVDB-SOURCE-REVIEW.md) | 固定提交全部原始文件、通知、归档替换修复及导出约束 |
| [原生补丁与嵌套来源 Review](NATIVE-PATCH-REVIEW.md) | 五份补丁原文、导出失败路径修复及 gvdb 嵌套来源缺口 |
| [优先 crate 来源 Review](PRIORITY-CRATES-REVIEW.md) | 固定提交逐文件匹配、MIT/MPL 原始材料及 HTTPS 声明校验修复 |
| [Rust 离线范围 Review](RUST-RESOLUTION-REVIEW.md) | 四种 ARM64 候选集合、重建锁范围、隔离解析与导出约束 |
| [缺通知 crate Review](CRATE-FOLLOWUP-REVIEW.md) | README／源码前缀复核、原始锁与构建锁边界及导出校验 |
| [crate 原始材料 Review](CRATE-NOTICES-REVIEW.md) | 357 个归档 checksum、原始清单/通知、UNLICENSE 漏采修复与导出校验 |
| [Rust 锁文件 Review](RUST-LOCK-REVIEW.md) | librsvg 原始 Cargo 输入、366 项锁定记录及导出校验边界 |
| [原始通知与导出 Review](COMPONENT-NOTICES-REVIEW.md) | 全部声明源归档、原始通知候选和实际导出完整性门禁 |
| [原生来源 Review](NATIVE-SOURCE-REVIEW.md) | libvips精确源包/补丁依据、声明与包含区别及扫描完整性 |
| [镜像分发 Review](DISTRIBUTION-REVIEW.md) | 许可发现修复、镜像盘点及独立发行门槛 |
| [内容双版本接续 Review](CONTENT-SAVE-REVIEW.md) | 草稿/发布/下架确认基线、写入互斥和发布精确重试 |
| [内容批量发布 Review](BULK-PUBLISH-REVIEW.md) | 勾选草稿批量发布、逐项事务与部分失败边界 |
| [资源连续保存 Review](RESOURCE-SAVE-REVIEW.md) | 本次确认版本接续、输入保留及保存/刷新失败区分 |
| [列表请求顺序 Review](CONTENT-LIST-REVIEW.md) | 整页载入竞态、过期错误与加载状态归属 |
| [分类与投稿审核 Review](CONTENT-MODERATION-REVIEW.md) | 多区域编辑保留、局部回填和审核后刷新恢复 |
| [内容编辑 Review](CONTENT-EDITOR-REVIEW.md) | 同页切换记录、迟到结果和保存后编辑保留 |
| [后台审计日志 Review](AUDIT-LOG-REVIEW.md) | 只读审计查询、站点级权限、游标分页与边界 |
| [后台导航 Review](ADMIN-NAVIGATION-REVIEW.md) | 跨页迟到响应、失败重试及配置文件载入交错 |
| [内容文件协作 Review](CONTENT-EXCHANGE-REVIEW.md) | 大页导出拆分、文件选择竞态和实际HTTP往返 |
| [运维失败路径 Review](OPERATIONS-REVIEW.md) | 源码流式下载、取消释放、备份同步和恢复版本校验 |
| [发行边界与依赖 Review](RELEASE-REVIEW.md) | 许可通知固定来源、扫描和依赖完整性修复 |
| [源码许可与镜像证据推进 Review](SOURCE-LICENSE-DECISIONS.md) | MIT 归属决定、sharp 移除、六组镜像证据与关闭路径 |
| [上游许可确认请求](UPSTREAM-LICENSE-REQUESTS.md) | Better Auth 与 client-only 的许可/版权确认草稿及回复记录规则 |
| [P5 运行与发行准备](P5-FINAL.md) | 备份恢复、容量、Review、发行边界与验收证据 |
| [发行前检查清单](RELEASE-CHECKLIST.md) | 环境预检、全量回归、Docker、OAuth、门禁与证据模板 |
| [镜像分发人工审查指南](IMAGE-REVIEW-GUIDE.md) | 六组镜像逐项核对、署名格式与 AGPL 兼容性提示 |
| [六组镜像审查工作表](IMAGE-REVIEW-WORKSHEET.md) | 每组已具备/仍缺内容、签署前最低核对项 |
| [六组镜像逐组决定卡](IMAGE-DECISION-CARDS.md) | 每组一页，圈选接受/保留/pending 并签署 |
| [2026-10-21 代码 Review 修复记录](CODE-REVIEW-20261021.md) | 错误日志、限流、运营者生命周期、缓存、备份、GitHub 统计与 session 收敛 |
| [2026-10-20 本地验收记录](ACCEPTANCE-20261020.md) | P0–P5、发行测试与 Docker 验收的实际结果 |
| [P5 运维操作](P5-OPERATIONS.md) | 加密备份、隔离恢复、升级、源码归档和容量重现 |
| [P4 交付与 Review](P4-FINAL.md) | GitHub 模块实现、认证追加修复及验收 |
| [P4 GitHub 操作](P4-GITHUB.md) | 来源、任务、字段审核、独立发布与 CLI |
| [P3 交付与待联调项](P3-FINAL.md) | 模板与认证实现、Review、验证及真实平台待验收边界 |
| [P3 认证操作](P3-AUTH.md) | 提供方配置、账号绑定/解绑、邮件、代理、会话与清理 |
| [GitHub/Google 上线前验收手册](OAUTH-ACCEPTANCE.md) | 真实凭据回调、冲突、绑定/解绑与回滚检查表 |
| [模板开发](TEMPLATE-DEVELOPMENT.md) | SDK、AI 示例、夹具预览与审查要求 |
| [P2 交付与 Review](P2-FINAL.md) | 内容系统交付、Review 修复与验收证据 |
| [P2 内容操作](P2-CONTENT.md) | 数据模型、权限、公开查询、收藏投稿、文件与 CLI 协议 |
| [P1 交付与 Review](P1-FINAL.md) | P1 实现范围、修复与验证证据 |
| [P1 安装操作](P1-OPERATIONS.md) | Docker、HTTPS 演示、后台、CLI、任务与升级 |
| [P0 最终验收](P0-FINAL.md) | P0 完成状态、31 场景证据、退出结论与投入重估 |
| [认证实施决策](ADR-001-AUTH.md) | 已验证适配基线及 P1/P3 边界 |
| [来源核查](P0-SOURCE-AUDIT.md) | 新写代码、依赖许可文件、排除项和发布门槛 |
| [开发方案](DEVELOPMENT-PLAN.md) | 首版范围、阶段、投入估算和交付要求 |
| [配置协议](CONFIGURATION.md) | 后台与文件协作、草稿、冲突、发布和回滚 |
| [账号设计](IDENTITY.md) | 身份边界、共享登录、故障与迁移策略 |
| [公共数据访问](DATA-ACCESS.md) | 可见性、模板边界、Host、语言和缓存 |
| [P0 第四轮进度](P0-ITERATION-4.md) | 会话对账、清理恢复及迁移范围纠正 |
| [P0 第三轮进度](P0-ITERATION-3.md) | 浏览器规范身份、首次并发登录及预览权限 |
| [P0 第二轮进度](P0-ITERATION-2.md) | 事件消费、进程恢复、身份映射与剩余项 |
| [P0 验证结果](P0-RESULTS.md) | 执行证据、限制和剩余投入 |
| [P0 Review](P0-REVIEW.md) | 已修复问题与保留风险 |
| [直接依赖](DEPENDENCIES.md) | 锁定版本和声明许可证 |
| [P0 验证计划](P0-VALIDATION.md) | 场景清单、通过条件、证据和退出标准 |

专题规则以对应文档为准；开发方案只保留摘要。背景调研记录作为本地交接材料单独保留，不进入公开文档集。

