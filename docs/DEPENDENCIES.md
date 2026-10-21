# 直接依赖来源清单

来自安装包元数据，用于来源记录，不代替完整依赖许可核查。代码未复制到项目源码。

| 包 | 版本 | 声明许可证 |
| --- | --- | --- |
| @better-auth/oauth-provider | 1.7.10 | MIT |
| better-auth | 1.7.10 | MIT |
| next | 16.4.2 | MIT |
| pg | 8.23.1 | MIT |
| react | 19.3.1 | MIT |
| react-dom | 19.3.1 | MIT |
| zod | 4.6.7 | MIT |
| @playwright/test | 1.64.1 | Apache-2.0 |
| @types/node | 24.19.2 | MIT |
| @types/pg | 8.23.1 | MIT |
| @types/react | 19.3.0 | MIT |
| tsx | 4.23.15 | MIT |
| typescript | 5.9.3 | Apache-2.0 |

## P0 收尾时的随包许可文件核查

除包元数据外，本轮检查了以下实际文件，并保存内容摘要。版本以上表及锁文件为准；未修改第三方包内容。此表不代替发布时的传递依赖与镜像分发审计。

| 包 | 文件 | SHA-256 |
| --- | --- | --- |
| @better-auth/oauth-provider | LICENSE.md | `7a07f7d9085cb3157e4377d944988c9712933141b0f7201955ceccfac92abde4` |
| better-auth | LICENSE.md | `7a07f7d9085cb3157e4377d944988c9712933141b0f7201955ceccfac92abde4` |
| next | license.md | `ee765244e2d59f5234d474f62e0766fa0c8b99af967fdd4c0cb8dcb0c76ea224` |
| pg | LICENSE | `192b8f5c96900f04a1271dec39688655d7416c1c6ea84a508e18b50d2b6751f3` |
| react | LICENSE | `da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93` |
| react-dom | LICENSE | `da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93` |
| zod | LICENSE | `3f1189b28e3866e0d979968d466b78f813f76827cfdca1fbb124cc0a5c8841f8` |
| @playwright/test | LICENSE | `45873d00a0dd243596deb4aa23b2493b3d1f0671921bf2538ea431d7380220eb` |
| @playwright/test | NOTICE | `6d602191187b35b9b01d2cffa01c8469c2c8d9de8a96f1bf868e0f264f51c81d` |
| @types/node | LICENSE | `c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383` |
| @types/pg | LICENSE | `c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383` |
| @types/react | LICENSE | `c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383` |
| tsx | LICENSE | `8dded67841a9261a622c739fb61c81785e93765de852828ceeb9403d20a74581` |
| typescript | LICENSE.txt | `a7d00bfd54525bc694b6e32f64c7ebcf5e6b7ae3657be5cc12767bce74654a47` |

## P1 运行镜像

Node 24 bookworm-slim、PostgreSQL 18 Alpine 和演示 Caddy 均按镜像摘要固定，准确摘要见 Dockerfile、compose.yaml 和 compose.demo.yaml。P1 未新增应用运行时 npm 依赖。镜像层及传递依赖的完整分发许可证审计仍在公开发行前完成。

## P3 邮件依赖

| 包 | 锁定版本 | 随包声明 | LICENSE SHA-256 |
| --- | --- | --- | --- |
| nodemailer | 10.1.2 | MIT-0 | `4f814dcacd2da618d62829ea1f6238701cf421f18a6b36c91c5d8212245e2c78` |
| @types/nodemailer | 8.0.2 | MIT | `c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383` |

Nodemailer 用于 Worker SMTP 投递，没有复制其源码到本项目。锁文件记录具体传递依赖；P5 用户已选择 AGPL-3.0-only；完整安装树通知和待核查项由源码归档工具生成。


P4 未新增 npm 包；GitHub 客户端使用 Node fetch 和既有 Zod 校验，模块与同步源码为本项目新写，未迁入旧站平台源码。

P5 后续：原8项缺失通知中4项有固定版本上游证据，本地文本及哈希见 [review.json](../third-party/review.json)；其余4项及原生二进制分发另见 [发行 Review](history/RELEASE-REVIEW.md)。
