# 模板 SDK 与 AI 开发

P3 提供 API v1，以及 `basic` 精选目录、`editorial` 编辑手记两个可部署模板。后者是本项目由 AI 编写、经实现者 Review 和测试的例子，不代表任意 AI 输出都能直接上线。

## 边界

模板是与应用一起部署的可信代码，SDK 和静态依赖检查不是安全沙箱。AI 生成的模板上线前必须经人工审查；不能把“检查通过”等同于代码可信。站点编辑者只选择已安装模板和填写参数，不能通过配置上传、执行代码。

唯一公开入口为 `src/public/sdk.ts`。模板接收已过滤的 DTO，不接收数据库连接、环境变量、密钥、用户会话或内部备注。列表、详情、分类计数及语言链接由公共数据层先计算；模板不能自行放宽可见性。

`pnpm check` 递归检查模板及 SDK 的静态导入，拒绝服务端/数据库依赖、未许可包、`process`、`globalThis`、`require`、动态导入、`eval` 和 `Function`。这是架构门禁；它不覆盖所有 JavaScript 绕过方式，不能安全运行恶意代码。

## 开发流程

1. 从 `src/templates/basic.ts` 或 `editorial.ts` 复制结构，导出 `defineTemplate({id, apiVersion:1, render})`；文本和属性值使用 `escapeHtml`，不要拼接未转义内容。
2. 支持 `directory`、`detail`、`missing` 三种页面；保留空结果、搜索/分类/分页、收藏、语言链接、canonical/hreflang 和 noindex。使用 SDK 的 `frame`、`metadata` 等可复用函数。
3. 在 `src/server/templates.ts` 注册实现，在 `src/templates/manifest.ts` 声明 ID/名称/版本及 CSS。新增模板需要构建部署。
4. 运行下面的夹具预览、架构检查和测试；检查手机、桌面、键盘操作、空列表、缺译页以及长文本。人工审查后再部署，通过后台草稿选择模板，预览并发布。

```bash
pnpm template:preview
pnpm check
pnpm test:p3
pnpm build
```

预览脚本生成 `.local/template-preview/` 下 8 个独立 HTML：两个模板各自的列表、详情、缺译和空结果页。可直接本地打开；预览仅使用 `fixtures/templates/directory.ts`，无需数据库、真实账号或生产数据。预览不执行收藏/登录脚本，链接不模拟后端接口。

运行时会克隆并冻结 DTO，再调用模板；参数拒绝未知字段，不兼容 API 或未注册模板不能渲染/发布。API v1 是此项目当前约定，还不是可独立安装的 npm 包或跨版本兼容承诺。

## 参数

两个模板共用严格参数 Schema：

| 参数 | 值与省略行为 |
| --- | --- |
| accent | forest（显示默认）、indigo、terracotta |
| density | comfortable（显示默认）、compact |
| eyebrow | 最长 100 字；省略使用模板内置文案 |
| footer | 最长 300 字；省略使用 SDK 页脚 |

完整快照示例片段：

```json
{"template":"editorial","templateParams":{"accent":"terracotta","density":"comfortable","eyebrow":"THE READING ROOM"}}
```

上述片段放在配置的 `config` 中，不是完整导入文件。省略 `templateParams` 规范化为 `{}`；省略某个参数使用显示默认值，不保留旧快照中的该字段。后台基础表单可选择模板，参数可在完整配置 JSON 编辑，也可导出后交给 AI 修改、校验并导入。模板选择属于配置发布；模板源码变化属于代码部署。

## 可交给 AI 的任务

> 请阅读 src/public/sdk.ts、src/templates/basic.ts 和 fixtures/templates/directory.ts，编写 API v1 导航模板。只从公开 SDK 导入，不访问数据库、环境、认证或网络。支持列表、详情、缺译与空列表，保留搜索、分类、分页、收藏和 SEO。所有动态文本必须转义。样式响应式且尊重键盘焦点。给出模板、注册项和 CSS 的实际修改，运行预览与检查。提交供人工审查，不能自动上线。

AI 也可只改模板参数或导航配置；这种场景无需生成新代码，仍按草稿、比较、预览、发布流程执行。


P4 在 API v1 DTO 中增加可选 `project` 元数据；内置模板显示批准发布时的 Stars、语言、许可证与归档状态。原模板可忽略该可选字段，不能自行请求 GitHub 刷新内容；定义见 SDK 的 `PublicProject`。

## 部署源码获取

P5 在模板服务端出口追加 `/source.tar.gz` 获取入口，构建时生成对应源码归档。保留该入口；自定义模板可以使用 SDK frame，也兼容 HTML 结束标签大写或省略的输出。原始离线夹具预览不经过部署出口。运行和许可边界见 [P5 运维](P5-OPERATIONS.md)。
