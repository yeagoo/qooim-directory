# 发布前整合验收记录

日期：2026-10-21。范围：M1–M5 合并后的内部发布候选（RC）验收，不是公开发行批准。

## 结论

**内部整合验收：通过（受控环境）**

- 代码、测试、构建、源码/镜像门禁、Docker 整合链路全部通过。
- 新功能在同一个 Docker 安装中完成媒体上传/发布/公开访问、搜索、AI 配置保存和采集来源创建。

**公开发布：暂不批准（NO-GO）**

原因不是代码失败，而是以下外部/人工验收尚未完成：

1. 真实 GitHub/Google OAuth 未配置，preflight 报 2 个警告。
2. 真实 AI 供应商未联调；测试使用注入传输。
3. 真实 RSS/npm 外网源未联调；测试使用受控 fixture。
4. Passkey 仅用 Chromium 虚拟认证器，未做真实设备/平台同步验收。
5. ~~新增依赖和刷新后的镜像 evidence 尚未由审查人 QooIM 重新确认。~~ 已完成：QooIM 于 2026-10-21 确认当前六组 evidence（见复核包）。
6. `v0.1.0` tag 不包含 M1–M5；版本号、tag 和发布说明尚未最终决定。

## 环境

| 项 | 值 |
| --- | --- |
| 主机 | linux/arm64 |
| Node | v24.21.0 |
| pnpm | 10.11.1 |
| Docker | 29.2.1 |
| Compose | v5.1.0 |
| PostgreSQL | 18（镜像摘要固定） |
| 浏览器测试 | Playwright 1.64.1，Chromium/Firefox |
| 最终镜像 | `sha256:6f4c4af3...` |

## 结果

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
pnpm test:docker           通过（含新增整合链路）
pnpm release:check         通过
pnpm release:check:image   通过
preflight                  18 项：0 硬失败，2 警告
```

### Docker 整合链路实际验证

同一个临时 Compose 安装中：

- 空数据库、迁移、初始化、三个演示站、HTTPS 路由；
- 后台登录、公开登录、共享账号浏览器登录；
- 内容主档/站点发布/冻结快照/恢复；
- 媒体上传（PNG）、草稿引用、发布、公开 `/media/<id>` 返回原图；
- 搜索命中新发布资源；
- AI 配置保存，API Key 不回显；
- 采集来源创建，列表返回；
- Worker 重启、数据库恢复、GitHub 候选审核。

关键日志：

- `Media, search, AI config and collector integration passed`
- `Docker acceptance passed: empty database, three sites, HTTPS shared browser login, operator login, persistent configuration/template/content/favorites/session, SMTP verification, GitHub project persistence, worker restart, database recovery`

### 测试覆盖矩阵

| 功能 | 自动化证据 | 外部真实环境 |
| --- | --- | --- |
| 独立账号/搜索 | P1/P2、Docker | 未验证真实域名/DNS/TLS |
| Passkey | P3 虚拟认证器 | 未验证真实设备/平台同步 |
| 媒体/备份 | P2/P3/P5、Docker 上传 | 未做生产卷灾难恢复演练 |
| AI | P2 注入传输、P3 配置 UI、Docker 配置 | 未调用真实 provider |
| 采集器 | P4 fixture、Docker 来源创建 | 未调用真实 RSS/npm |
| OAuth | P3 受控 OIDC fixture | GitHub/Google 未配置 |

## 本轮发现

1. **媒体卷权限是部署级硬约束**  
   Docker 整合测试首次上传返回 `EACCES: mkdir /app/data/media/atlas`。原因是绑定目录在容器内不可写；必须让 `MEDIA_HOST_PATH` 对容器 UID 1000 可写（例如 `chown 1000:1000 ./data/media`）。文档已记录，Docker 测试使用显式可写临时目录。
2. **Docker 测试清理需要容器内 chmod**  
   容器创建的媒体文件属于容器 UID；宿主机清理前用一次性 root 容器 `chmod -R 777`，避免测试残留。
3. **GitHub 仍是独立专用链路**  
   新采集器没有复用 `github_source`；两套来源入口并存，需在后续版本统一或明确长期边界。
4. **镜像 evidence 已由审查人确认**  
   新依赖和最终镜像已重新取证；QooIM 于 2026-10-21 确认当前六组 evidence 与候选镜像一致，并接受其 limitations。确认不是法律意见。

## 发布前剩余条件

### 必须完成（公开发布阻断）

- 配置并实测 GitHub、Google OAuth（真实回调、账号绑定/解绑、共享站/独立站）。
- 用真实 AI 供应商完成一次生成、一次翻译、一次失败/超时、预算耗尽的验收，并确认数据出境/ToS。
- 用真实 RSS 与 npm 源完成一次采集、候选审核、草稿发布；确认来源条款与限流。
- 真实 Passkey 设备（至少两个平台/一个密码管理器）注册、登录、删除、恢复演练。
- ~~由审查人重新确认刷新后的源码/镜像 evidence。~~ 已完成，见 [evidence 复核包](IMAGE-EVIDENCE-REVIEW-PACKET-20261021.md)。
- 决定版本号/tag（建议 `v0.2.0`）并更新 CHANGELOG/Release notes。

### 建议完成（不阻断内部 RC）

- SMTP 真实投递、退信和限流演练（Docker 只用 Mailpit）。
- 生产容量/长稳测试；当前容量数据是开发基线，不是 SLA。
- 媒体卷备份/恢复的整套主机级演练（P5 已测归档恢复，不是灾难切换）。
- 真实域名、TLS、DNS、代理头与 `PROXY_TRUST_TOKEN` 验收。
- 清理 `.local/` 日志与临时媒体（不影响代码）。

## 建议下一步

1. 先完成外部凭据验收（OAuth、AI、RSS/npm、真实 Passkey）。
2. 审查人确认 evidence 后，决定 `v0.2.0`。
3. 更新 tag/Release、部署 staging，做一次从备份恢复的灾难演练。
4. 再进入公开发布。
