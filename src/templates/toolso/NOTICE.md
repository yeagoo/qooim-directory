# toolso 模板来源说明

本目录的界面代码（组件、样式 token、Tailwind 配置、文案）移植自 `toolso-ai-open`：

- 版权：Copyright 2025 CoolChange.AI
- 许可证：Apache License 2.0，全文见同目录 [LICENSE-APACHE-2.0.txt](LICENSE-APACHE-2.0.txt)
- 权属：维护者 QooIM 于 2026-10-23 确认 toolso 的代码和自有素材归其所有，见 [对照清单](../../../docs/TOOLSO-COMPARISON-20261023.md)

移植时有以下修改：
- 页面改为服务端静态渲染，不在浏览器里执行 React；交互由 `src/ui/toolso.js` 用原生 JS 实现。
- Next 专用的 API（`next/link`、`next/image`、`next-intl`、`next-themes`）换成 `shims/` 下的等价实现。
- 品牌色不再写进 `<html style>`，改由 `/assets/theme/<hex>.css` 提供，以符合 CSP。
- 没有带入来源不明的图片（如 `noise.webp`），也没有带入 toolso 各站自己的品牌素材；颗粒背景改用自绘的 SVG。

从这里修改并分发的文件，整体仍按本项目的 AGPL-3.0-only 发布；被移植的部分继续保留上面的 Apache-2.0 声明。

Geist 字体（`src/ui/fonts/*.woff2`）：Copyright (c) 2023 Vercel, in collaboration with basement.studio，SIL Open Font License 1.1，全文见 `src/ui/fonts/OFL-Geist.txt`。
