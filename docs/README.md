# Qoo.IM Directory 文档

更新日期：2026-10-21。首版 P0–P5 已实现并通过回归；源码与镜像门禁已通过，六组镜像为带保留签署。公开发行仍待真实 GitHub/Google 联调、域名/仓库名和容量边界确认。

## 先读

| 文档 | 用途 |
| --- | --- |
| [项目交接总览](PROJECT-HANDOFF.md) | 当前状态、剩余任务、建议顺序 |
| [模型交接提示词](MODEL-HANDOFF-PROMPT.md) | 给后续模型的最小上下文 |
| [开发方案](DEVELOPMENT-PLAN.md) | 首版范围、阶段和投入 |
| [认证实施决策](ADR-001-AUTH.md) | 身份适配基线与边界 |
| [2026 Q4 功能规划与 Review](FEATURE-PLAN-2026Q4.md) | 独立账号方向、搜索/Passkey/媒体/AI/采集的范围、风险与顺序 |
| [M6–M10 开发方案](FEATURE-PLAN-M6-M10.md) | 配额与保留期、运维 UI、媒体版本、AI 治理、GitHub 统一采集器 |

## 操作与协议

| 文档 | 用途 |
| --- | --- |
| [P1 安装操作](P1-OPERATIONS.md) | Docker、HTTPS、后台、CLI、任务与升级 |
| [P2 内容操作](P2-CONTENT.md) | 数据模型、权限、公开查询、收藏投稿、文件与 CLI |
| [媒体/图片管理](P2-MEDIA.md) | 站点媒体库、上传校验、公开访问、删除保护与备份 |
| [P3 认证操作](P3-AUTH.md) | 提供方配置、账号绑定/解绑、邮件、代理与会话 |
| [内置 AI 生成/翻译](P3-AI.md) | 站点级供应商配置、异步任务、预算、人工确认与安全边界 |
| [P4 GitHub 操作](P4-GITHUB.md) | 来源、任务、字段审核、统计自动更新与独立发布 |
| [垂直采集器](P4-COLLECTORS.md) | RSS/npm/通用 JSON、候选审核、SSRF 边界与限制 |
| [P5 运维操作](P5-OPERATIONS.md) | 加密备份、隔离恢复、升级、源码归档和容量重现 |
| [模板开发](TEMPLATE-DEVELOPMENT.md) | SDK、AI 示例、夹具预览与审查要求 |
| [GitHub/Google 上线前验收](OAUTH-ACCEPTANCE.md) | 真实凭据回调、冲突、绑定/解绑与回滚 |
| [配置协议](CONFIGURATION.md) | 草稿、冲突、发布和回滚 |
| [账号设计](IDENTITY.md) | 身份边界、共享登录、故障与迁移 |
| [公共数据访问](DATA-ACCESS.md) | 可见性、模板边界、Host、语言和缓存 |
| [直接依赖](DEPENDENCIES.md) | 锁定版本与声明许可证 |

## 发行与证据

| 文档 | 用途 |
| --- | --- |
| [发行前检查清单](RELEASE-CHECKLIST.md) | 预检、全量回归、Docker、OAuth、门禁 |
| [镜像 evidence 复核包（M6–M11 候选）](IMAGE-EVIDENCE-REVIEW-PACKET-20261023.md) | 新候选镜像的六组 evidence、与 rc.1 的比对，QooIM 已于 2026-10-23 确认 |
| [本地验收记录](ACCEPTANCE-20261020.md) | P0–P5、发行与 Docker 实际结果 |
| [M1 验收记录](ACCEPTANCE-M1-20261021.md) | 独立账号收口、pg_trgm 搜索、测试与 Docker |
| [M6 验收记录](ACCEPTANCE-M6-20261022.md) | 配额与保留期：P0–P6 回归、10 万候选清理、保留项 |
| [M7 验收记录](ACCEPTANCE-M7-20261023.md) | 运维 UI：AI/采集任务取消与重试、批量审核、保留期展示 |
| [M8 验收记录](ACCEPTANCE-M8-20261023.md) | 媒体替换、版本历史、发布冻结图片版本、批量上传 |
| [M9 验收记录](ACCEPTANCE-M9-20261023.md) | 提示词版本、用量对账、余额检查 |
| [M10 验收记录](ACCEPTANCE-M10-20261023.md) | GitHub 迁入统一来源/任务表、迁移演练、兼容层 |
| [toolso 对照清单](TOOLSO-COMPARISON-20261023.md) | 旧项目界面与功能的借鉴取舍，待维护者决定 |
| [M12 验收记录](ACCEPTANCE-M12-20261023.md) | toolso 前台模板：React 模板、首页与分类路由、回归结果 |
| [M13a 验收记录](ACCEPTANCE-M13A-20261024.md) | 富字段、本站标签与标签页、多分类、logo 与发布时间，回归结果 |
| [M13b 验收记录](ACCEPTANCE-M13B-20261024.md) | 本站榜单与榜单页、AI 富字段补全，回归结果 |
| [M11 验收记录](ACCEPTANCE-M11-20261023.md) | 按角色显示操作、媒体提交后删除、单条候选审核修复 |
| [M2 验收记录](ACCEPTANCE-M2-20261021.md) | 站点级 Passkey、虚拟认证器测试、升级与安全边界 |
| [M3 验收记录](ACCEPTANCE-M3-20261021.md) | 媒体库、图片发布、加密媒体备份与恢复 |
| [M4 验收记录](ACCEPTANCE-M4-20261021.md) | AI 配置/任务/预算、人工确认与测试 |
| [M5 验收记录](ACCEPTANCE-M5-20261021.md) | 三类采集器、候选接受为草稿、SSRF 与限制 |
| [发布前整合验收](ACCEPTANCE-INTEGRATION-20261021.md) | M1–M5 合并、Docker 整合、发布阻断项与结论 |
| [v0.2.0-rc.1 Release Notes](RELEASE-NOTES-v0.2.0-rc.1.md) | 预发布范围、验证与未完成项 |
| [镜像 evidence 复核包](IMAGE-EVIDENCE-REVIEW-PACKET-20261021.md) | QooIM 对六组镜像 evidence 的确认与保留项 |
| [代码 Review 修复记录](CODE-REVIEW-20261021.md) | 2026-10-21 的问题、修复与保留项 |
| [源码许可与镜像证据](SOURCE-LICENSE-DECISIONS.md) | MIT 归属、sharp 移除、六组证据 |
| [镜像审查指南](IMAGE-REVIEW-GUIDE.md) | 逐项核对、署名格式与 AGPL 提示 |
| [镜像审查工作表](IMAGE-REVIEW-WORKSHEET.md) | 每组已具备/仍缺内容 |
| [镜像逐组决定卡](IMAGE-DECISION-CARDS.md) | 每组的接受/保留决定 |
| [上游许可确认请求](UPSTREAM-LICENSE-REQUESTS.md) | 草稿与回复记录规则；未发送 |

## 历史记录

P0–P5 阶段交付、交互 Review、许可取证和镜像证据的详细过程已归档到[历史过程文档](history/README.md)，保留追溯，不作为当前操作入口。
