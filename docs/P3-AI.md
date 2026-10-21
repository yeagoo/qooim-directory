# 内置 AI 生成/翻译

状态：M4 已实现。AI 是**建议工具**，不自动保存、不自动发布。

## 范围

- 站点级 OpenAI-compatible HTTPS 端点；原生 `https.request`，不引入 AI SDK。
- 三类任务：
  - `generate`：根据现有标题/说明/要求生成或改写标题、说明；
  - `translate`：中英标题/说明互译；
  - `seo`：生成 SEO 标题（≤60 字）和 SEO 说明（≤155 字）。
- 异步任务由 Worker 消费；管理页轮询结果，人工点击“应用到候选 JSON”后才进入草稿，仍需正常保存/发布。
- 不做：自动发布、自动改已发布内容、网页抓取/URL 总结、图片生成、向量检索、工具调用。

## 配置

后台站点页 → “AI 设置”（`#ai/<site>`）：

| 字段 | 说明 |
| --- | --- |
| endpoint | 完整 HTTPS chat completions 地址，如 `https://api.openai.com/v1/chat/completions` |
| model | 供应商模型名 |
| API Key | 首次必填；更新时留空保留旧值，不回显 |
| 月度 token 预算 | 1000–100000000，按自然月已记录 token 累计 |
| enabled | 关闭后拒绝新建任务 |

Key 使用 `AUTH_ENCRYPTION_KEY` 经 AES-256-GCM 封装后存 `ai_config.sealed_key`；Worker 才解密，API 只返回 `hasKey`。

## 数据与 API

迁移 `008-ai.sql` 新增 `ai_config`、`ai_job`。任务记录操作者、kind、payload、prompt version、provider model、token 用量、状态、错误码和时间；不记录 API Key。

| 方法/路径 | 用途 |
| --- | --- |
| `GET /admin/api/ai/config?site=<id>` | 读取脱敏配置 |
| `POST /admin/api/ai/config` | 保存配置；`key` 可省略保留 |
| `POST /admin/api/ai/jobs` | 创建任务 `{site,kind,locale,title?,description?,url?,brief?}` |
| `GET /admin/api/ai/jobs/<id>?site=<id>` | 轮询状态/输出/用量 |

任务状态：`pending → processing → done|failed`。Worker 每次处理一条，失败最多重试 2 次（30 秒退避），超时/失败保留错误码；崩溃遗留的 processing 租约会在下次运行回收。

## 安全

- 端点必须 HTTPS，拒绝 userinfo、localhost、`.local/.internal`、字面私网 IP；Worker 解析 DNS 后拒绝任一私网/保留地址，并用解析结果固定连接，禁用重定向。
- 请求 30 秒超时、响应 ≤256 KiB；密钥只在服务端内存/请求头出现，不写日志。
- 系统提示把用户内容标记为不可信数据；不启用工具/function calling，降低提示注入影响。
- 输出经严格 Zod schema 校验，超长/非法 JSON 视为失败；不自动回写。
- 预算按站点自然月累计已记录 token；超预算拒绝新任务，Worker 再检查一次。

## 限制与未验证

- 没有真实 OpenAI/Anthropic 或第三方兼容端点联调；测试使用注入传输，验证队列/校验/预算/人工确认，不证明供应商可用性或内容质量。
- 没有 token 计费对账、供应商账单同步、提示词版本管理 UI、任务取消/重试 UI、保留期清理。
- 端点 DNS 固定是尽力而为的 SSRF 缓解，不替代出站防火墙/代理。
- AI 输出可能不准确；发布者必须核对事实、版权、翻译质量和 SEO 声明。

## 验收

P2 覆盖密钥封装/脱敏、端点拒绝、任务创建、Worker 输出、预算；P3 覆盖后台 AI 设置与内容页 AI 面板。详见 [M4 验收](ACCEPTANCE-M4-20261021.md)。
