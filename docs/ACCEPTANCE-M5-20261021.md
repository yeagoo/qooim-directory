# M5 验收记录：更多垂直采集模块

日期：2026-10-21。范围见 [2026 Q4 功能规划](FEATURE-PLAN-2026Q4.md) M5。

## 变更

- 迁移 `009-collectors.sql`：`collector_source`、`collector_task`、`collector_candidate`。
- 新增 RSS/Atom、npm 官方搜索、通用 JSON 三种采集器；统一候选审核。
- 两种入口：
  - 后台站点页“采集器”：创建来源、立即同步、接受/拒绝候选；
  - 接受只创建 `collector-<id>` 资源主档和内容草稿，**不会自动发布**。
- SSRF 防护复用公开 HTTPS 校验、DNS 私网拒绝、大小/超时/重定向上限。
- GitHub 专用同步保留不动，未迁移到新表；既有 GitHub 测试继续通过。

## 验证

```text
pnpm check                 通过
pnpm build                 通过
P0 48/48
P1 88/88
P2 137/137
P3 39/39
P4 30/30
P5 11/11
pnpm test:release          69/69
pnpm test:docker           Docker 整体验收通过
pnpm release:check         通过
pnpm release:check:image   通过
```

P4 新增覆盖：

- RSS 两条候选、接受后只创建草稿、无 publication；
- RSS DOCTYPE 拒绝；
- npm 搜索结果规范化；
- 通用 JSON 字段映射；
- 私网 URL 保存拒绝；
- 原有 GitHub 30 项回归保留。

Docker 使用 `m5-final-20261021` 进行空库/三站/登录/内容/恢复验收；最终应用镜像 `sha256:7a3c5c6f...`。

## 升级注意

- 迁移只新增表；不影响既有 GitHub 来源。
- 定时任务由 Worker 调度：RSS/npm/JSON 来源启用后，Worker 每轮最多处理一条任务。
- 候选接受需要站点编辑权限；没有自动发布路径。
- 采集源配置不保存凭据；需要认证的源不在本轮范围。

## 未完成/风险

- GitHub 仍是独立专用表/Worker，未完成“所有来源统一 adapter”重构。
- 没有 YouTube/Product Hunt、登录态、代理、Webhook、批量审核、保留期清理。
- RSS 正则解析只支持常见 RSS/Atom；异常 XML 会失败而非部分解析。
- npm 搜索依赖公开 registry 可用性和 terms；未做真实外网联调。
- 没有采集源数量/流量配额；部署者需用出站策略限制。
