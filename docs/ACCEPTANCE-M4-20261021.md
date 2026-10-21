# M4 验收记录：内置 AI 生成/翻译

日期：2026-10-21。范围见 [2026 Q4 功能规划](FEATURE-PLAN-2026Q4.md) M4。

## 变更

- 迁移 `008-ai.sql`：`ai_config`（站点端点/模型/封装 Key/预算/开关）和 `ai_job`（异步任务/用量/租约/错误）。
- 原生 HTTPS OpenAI-compatible 调用，无 AI SDK；30 秒超时、256 KiB 响应上限、DNS 私网拒绝、禁重定向。
- 三类任务：生成/改写、翻译、SEO；严格输出 schema，最多重试 2 次，预算按自然月累计。
- 后台站点页新增“AI 设置”；内容页新增“AI 辅助”，输出只应用到候选 JSON，必须人工保存/发布。
- Worker 集成 `runJobs`；配置/任务进入数据库备份；未改变 Passkey/账号/媒体作用域。

## 验证

```text
pnpm check                 通过
pnpm build                 通过
P0 48/48
P1 88/88
P2 137/137
P3 39/39
P4 28/28
P5 11/11
pnpm test:release          69/69
pnpm test:docker           Docker 整体验收通过
pnpm release:check         通过
pnpm release:check:image   通过
```

P2 使用注入传输验证：Key 不落明文/不通过 API 回显、localhost 端点拒绝、任务输出、预算上限；未使用真实供应商。Docker 使用 `m4-final2-20261021` 进行空库/三站/登录/内容/恢复验收；最终应用镜像 `sha256:eea096d9...`。

## 升级与配置

- 部署新迁移后启动 Worker；没有 `ai_config` 的站点保持禁用。
- 真实 provider 需要部署者提供 endpoint/model/key，并自行确认 ToS、数据出境、计费和速率限制。
- 密钥轮换通过重新保存 key 完成；旧任务不重放。
- 建议出站防火墙只允许批准供应商域名；应用层 SSRF 防护不是网络隔离替代品。

## 风险

- AI 输出事实/翻译/SEO 质量未经真实模型评估。
- 提示注入已降低（无工具、严格 schema），但不能保证模型不产生错误内容。
- token 预算按应用记录，不保证与供应商账单完全一致。
- 未实现任务取消/重试 UI、保留期清理、供应商余额检查。
