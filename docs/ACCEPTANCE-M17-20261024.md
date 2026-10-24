# M17 验收记录：toolso 默认模板与后台初版改版

日期：2026-10-24。分支 `m17-design`，已合并进 `main`。这是本地回归记录，不是发布批准。

## 内容

- **新站点默认使用 toolso 模板**：
  - `Sites` 新增 `defaultTemplate` 参数，默认值为 `toolso`。
  - 已有站点不会自动迁移，可以在站点配置里换回 basic 或 editorial。
  - 旧测试显式传入 `defaultTemplate: "basic"`，保持原有断言不变。
  - 新增测试 `tests/p16/default-template.test.ts`。
- **后台初版改版**（深蓝侧栏、圆角面板、深色模式）：已被 [M19](ACCEPTANCE-M19-20261025.md) 的方案 3 取代，这里只作历史记录。

## 结果

- check、build、P0–P16 通过。P1、P2 在并行回归时各有 1 个用例失败，单独重跑分别 88/88、137/137 通过。
- 之后发现 `test:docker` 的收藏步骤失败：toolso 只在详情页提供收藏按钮。M18 分支已修正测试，改为先进入详情页（276ce36）。
