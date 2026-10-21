# 上游许可确认请求（草稿）

日期：2026-10-20。本文是可直接粘贴的请求草稿，**尚未发送**。

> 2026-10-20 维护者决定：**搁置上游确认，不发送这些请求**。本文件仅保留草稿和已核查的上游线程，供以后需要时参考；当前发行路径不再依赖上游回复。发送前由维护者确认收件渠道、署名和是否附带项目链接；不要把凭据、内部路径或 `.local/` 材料放进请求。

目标只有两个：确认精确发布版本的许可与版权归属。不要用“主分支已有 LICENSE”或“包元数据写了 MIT”代替对方对发布物的确认。

## 0. 先核查：上游已有两条线程（2026-10-20）

| 包 | 线程 | 状态 | 说明 |
| --- | --- | --- | --- |
| `@better-auth/utils` | [#38](https://github.com/better-auth/utils/issues/38) | OPEN，无维护者回复 | 2026-09-19 创建；2026-10-16 已有一条详细评论，列出 0.4.2/0.5.0 的归档 SHA-256 和 5 个问题。我们独立计算的 0.5.0 tarball SHA-256 与其一致（`63193eef...`）。**不要重复开新 issue。** |
| `client-only` | [#27242](https://github.com/react/react/issues/27242) | CLOSED（NOT_PLANNED / Stale） | 2023-08-18 创建，2024-04-14 关闭；2026-09-06 与 2026-10-15 有两条新评论补充精确包信息，仍无维护者回复。机器人关闭语明确说“若仍存在请新建 issue”。 |

因此，Better Auth 侧应先补充/等待 #38；React 侧若继续推进，需要按机器人提示新建 issue，并在正文引用 #27242 和那两条新评论。

## 1. Better Auth：`@better-auth/utils@0.5.0`

**建议渠道**：已有 [#38](https://github.com/better-auth/utils/issues/38)（OPEN）。优先在该 issue 下补充，不要新开重复 issue；只有维护者明确要求新开时才使用下方标题。

**标题**：`License clarification for @better-auth/utils@0.5.0`

**正文**：

```text
Hello,

We are auditing the exact npm artifact @better-auth/utils@0.5.0 before redistributing it in an AGPL-3.0-only open-source application.

The published package declares "license": "MIT" in package.json, but the tarball contains no LICENSE/COPYING/NOTICE file:

- Registry metadata: https://registry.npmjs.org/@better-auth/utils/0.5.0 (integrity sha512-BL8W4EfIZFwlu0r54m3v1ztjDhu6dDe/amLTm0xybmbZaNgYUqhD3SjpAsnq0q8YD6/ki4iwIgxJNLP/N3TxiA==)
- Tarball: https://registry.npmjs.org/@better-auth/utils/-/utils-0.5.0.tgz (58 files, 18,017 bytes)
- Published revision from provenance: f03c1c76aff7bfa3f4de4af47b112315c770a0d1; the repository tree at that revision has no LICENSE file.
- A later commit ef522888b7b2 (2026-07-27) added an MIT text with "Copyright (c) 2024 - present, Bereket Engida".

Could you confirm, for the 0.5.0 release specifically:

1. that the published code is licensed under MIT;
2. the exact copyright line that should accompany redistributed copies;
3. whether a 0.5.1 (or later) release could include the LICENSE file so downstream notices can bind to a published artifact.

A link to this issue in the release notes or a short written confirmation is enough. We are not asking for a legal opinion, only the project's statement of license and attribution for that release.

Thank you.
```

**收到回复后**：把回复 URL、日期、原文摘要和 SHA-256 写入 `third-party/upstream-license-responses.json`；只有回复明确覆盖 0.5.0 时，才把它作为 `@better-auth/utils@0.5.0` 的通知证据，并同步 `review.json` 与 [源码许可 Review](SOURCE-LICENSE-DECISIONS.md)。

## 2. React / Meta：`client-only@0.0.1`

**建议渠道**：新建 issue，并在正文开头引用已关闭的 [#27242](https://github.com/react/react/issues/27242) 及 2026-09-06、2026-10-15 两条补充评论；机器人关闭语允许“若仍存在请新建”。该包 npm 元数据的 bugs 字段指向 `facebook/react`（会重定向到 `react/react`）。

**标题**：`License/attribution clarification for the client-only@0.0.1 npm package`

**正文**：

```text
Hello,

This follows the closed request https://github.com/react/react/issues/27242 and the later comments there, which added exact package details without a maintainer response. We are auditing the exact npm artifact client-only@0.0.1 before redistributing it in an AGPL-3.0-only open-source application.

The published package declares "license": "MIT" in package.json, but the tarball contains only package.json, an empty index.js and an error.js, with no copyright line or permission text:

- Registry metadata: https://registry.npmjs.org/client-only/0.0.1 (integrity sha512-IV3Ou0jSMzZrd3pZ48nLkT9DA7Ag1pnPzaiQhpW7c3RbcqqzvzzVu+L8gfqMp/8IM2MQtSiqaCxrrcfu8I8rMA==)
- Tarball: https://registry.npmjs.org/client-only/-/client-only-0.0.1.tgz (3 files, 481 bytes)
- Published 2022-09-03 by npm user "sebmarkbage"; homepage https://reactjs.org/; bugs https://github.com/facebook/react/issues; no repository field.

Could you confirm, for client-only@0.0.1 specifically:

1. the copyright holder and copyright line that should accompany redistributed copies;
2. whether the package is intended to be covered by the React repository's MIT license, and if so, which exact text/version downstream should include;
3. whether the package could be republished with a LICENSE file (or the npm metadata updated) so the notice can bind to a published artifact.

A short written statement is enough. We are not asking for a legal opinion, only the project's attribution for that release.

Thank you.
```

**收到回复后**：同样保存原始回复与摘要。若回复只说明“React 使用 MIT”但没有给出该包的版权行，仍不足以关闭；需要明确覆盖 `client-only@0.0.1` 的表述或重新发布带 LICENSE 的版本。

## 3. 发送前的检查

- 不要附带你自己的 `.env`、数据库连接、内部绝对路径或未公开的旧站代码。
- 不要把 issue 链接当成“已确认”；只有回复正文才能作为证据。
- 如果维护者选择不发送，另一条路是维护者书面接受现有归属判断，并在 Review 中记录依据；这仍不是自动推断。
- 发送后在本文件记录渠道、日期、issue URL 和状态，避免重复提问。

## 4. 当前状态

| 包 | 渠道 | 状态 | 回复证据 |
| --- | --- | --- | --- |
| `@better-auth/utils@0.5.0` | [#38](https://github.com/better-auth/utils/issues/38) | 已搁置；不补充、不新开 | 无维护者回复 |
| `client-only@0.0.1` | [#27242](https://github.com/react/react/issues/27242) 已关闭 | 已搁置；不新建 issue | 无维护者回复 |
