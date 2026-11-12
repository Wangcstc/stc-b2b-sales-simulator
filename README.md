# stc-b2b-sales-simulator

**STC 外贸业务沙盘 · 询盘演练系统**

给外贸新人业务员的询盘陪练与上岗考核系统。业务员在浏览器里和 AI 扮演的海外买家对话，从接询盘一路谈到推进成交；系统按评分标尺打分、出复盘报告，再按考试结果判定能不能接真实询盘。

> v8.9.7 · 2026-11-12
> 新增站内企业合作页，支持复制微信号

## 能做什么

- **演习**：AI 扮演海外买家，题型覆盖考纲 55 型（只问价格型、技术尽调型、报价沉默型、售后纠纷型等），业务员练接待与跟进。题目由各公司用自己的聊天记录加工成题库包装入。
- **考试与准入**：实习业务员连续考试达标后，系统每晚自动结算，判定是否获得询盘接待准入资格；正式业务员有每周周考。
- **复盘报告**：每局结束后出评分报告，指出红线、扣分点和下一局该怎么改。
- **主管后台**：账号管理、工作日历、全队看板、难度系数调节、成本台账。

## 技术栈

Next.js 15 · React 19 · Prisma 6 · PostgreSQL 16 · DeepSeek（OpenAI 兼容协议）· Vitest

## 本地运行

**Windows 10/11、macOS、Linux 都支持**，命令完全一样（Windows 在 PowerShell 里敲）。每次发版都会在三种系统上自动安装、测试一遍。
不熟悉命令行的，看一步一步写的 [《安装说明》](docs/部署/安装说明.md)。

需要：Node.js 20 及以上、PostgreSQL 16（用 Docker 起，或直接安装）、你自己的 DeepSeek API 密钥。

```bash
git clone https://github.com/Wangcstc/stc-b2b-sales-simulator.git
cd stc-b2b-sales-simulator
npm install
npm run setup                 # 生成 .env 并自动填好 AUTH_SECRET；按提示填 DEEPSEEK_API_KEY
npm run db:up                 # 用 Docker 起本地数据库（端口 5433）；不用 Docker 见《安装说明》第三步
npx prisma migrate deploy     # 建表
npm run seed                  # 建主管账号 ADMIN
npm run bank -- load samples/bank  # 先装样品题库试玩（8 道虚构题，见 samples/README.md）
npm run dev                   # 打开 http://localhost:3100
```

用简码 **`ADMIN`** 登录。第一次登录时输入的口令就是以后的口令（至少 6 位，不能是纯数字）。

## 做自己公司的题库

题目由**抽屉**用你们公司自己的聊天记录加工出来：投料 → 脱敏 → 归型 → 起草 → 机器质检 → 主管点选确认 → 打包成题库包 → 装进柜子。

**主管在网页上做**：登录后点顶部「题库工坊」——投料（拖进聊天记录，脱敏在你自己的浏览器里完成，服务器只收脱敏后的内容）→ 加工（后台跑，可以关页面）→ 确认（全是选择题，推荐项排第一）→ 题库（打包上架、切换 / 回滚、导出、停用某道题）→ 覆盖（55 型各几道、考试还差什么）→ 回流（每道题的实战通过率、平均分、常见失分点；太容易、太难、总被同一句话破解的题出回炉建议，你选回炉 / 降为演习 / 下架 / 保留）。投多少份聊天都行。
托管平台（如 Vercel）上只开「题库」「覆盖」两页：在本机跑工坊打包，再上传题库包装入。

**命令行**（批量与运维，调的是同一套接口）：

```bash
npm run drawer -- ingest <批次> <聊天导出件目录> <产品表.xlsx> <公司信息表.xlsx>
npm run drawer -- run <批次>
npm run drawer -- reviews <批次>
npm run drawer -- pack <批次> --version 1.0.0
```

完整流程见 [`docs/操作单/抽屉使用说明.md`](docs/操作单/抽屉使用说明.md)。

## 部署

见 [`docs/部署/部署说明.md`](docs/部署/部署说明.md)。支持托管平台 + 云数据库、自有服务器 + Docker、内网电脑三种方式。

## 文档

| 文档 | 给谁看 |
|---|---|
| [`docs/业务员演习系统/新人使用说明_v2.0.md`](docs/业务员演习系统/新人使用说明_v2.0.md) | 业务员 |
| [`docs/系统管理员使用说明书_v1.1.md`](docs/系统管理员使用说明书_v1.1.md) | 主管 / 管理员 |
| [`docs/题库格式规范.md`](docs/题库格式规范.md) | 要读写题库包的人（由 Schema 生成） |
| [`standards/syllabus/README.md`](standards/syllabus/README.md) | 考纲：55 型各考什么（由考纲 JSON 生成） |
| [`standards/templates/投料说明.md`](standards/templates/投料说明.md) | 交原材料的人 |
| [`docs/操作单/抽屉使用说明.md`](docs/操作单/抽屉使用说明.md) | 做题库的人（网页题库工坊与命令行） |
| [`docs/操作单/人设编写须知.md`](docs/操作单/人设编写须知.md) | 要手工打磨题目的人 |
| [`docs/部署/安装说明.md`](docs/部署/安装说明.md) | 第一次在自己电脑上装的人（Windows / Mac / Linux） |
| [`docs/部署/部署说明.md`](docs/部署/部署说明.md) | 部署的人 |
| [`docs/部署/备份与恢复.md`](docs/部署/备份与恢复.md) | 运维 |

## 目录

```
standards/    标准层：考纲 55 型、七力、红线、题库格式 Schema、原材料模板（零依赖）
bank-kit/     题库工具包：题库包的读、写、校验、迁移（只依赖标准层）
engine/       判定引擎：状态机、暗牌解锁、评分口径（纯函数，柜子和抽屉共用）
drawer/       抽屉：原材料 → 题库包的加工流水线（不认识柜子）
samples/      样品：虚构原材料与样品题库包（发布包里唯一带的题）
src/          柜子：Next.js 应用（页面、接口）
prisma/       数据库结构与迁移
scripts/      题库装入、备份、自检、素材导入等脚本
docs/         使用与部署文档
```

## 开发约束

1. **状态机永远在代码里，不进 prompt。** prompt 里出现「你自己判断客户还有多少耐心」就要重写。
2. **`engine/` 是无菌区。** 不许 import 数据库 / LLM / Next.js，`npm run check:engine` 强制检查。
3. **判定不准的东西不伪装成客观。** 纯代码判定、结构化抽取、自由评分三层分开。

提交前跑：

```bash
npm run verify
npx tsc --noEmit
```

**对外发布**（开源、交付客户）：开发仓库早期的提交历史里有旧题库，不能直接发布。先 `npm run version:bump`、提交、打标签，再 `npm run release:export -- <发布仓库目录>` 把这个版本的文件导出到干净的发布仓库（每个版本一个提交），到那边 `npm ci` 后跑 `npm run release:check`，全过了再推。

**客户黑名单**：拿真实聊天做题的公司，把自家和客户的名字写进一个词表文件（放在仓库外），`.env` 里配 `BLACKLIST_FILE` 指过去，再装一次本机钩子 `npm run hooks:install`。之后每次提交都会扫这次的文件和提交说明，`npm run verify` 会扫工作区和全部提交历史，命中就拦下。没配词表时自动跳过。

## 安全

- 密钥只放 `.env`，不进 git。
- 导入真实聊天记录做素材时，脱敏在本机完成（`npm run drawer -- ingest`），原始记录不出本机、不进仓库；抽屉工作区 `workspace/` 在 `.gitignore` 里。

## 授权

双授权：开源用 [GNU AGPL-3.0](LICENSE)（改过的代码对外提供服务时要开源；题库是你们自己的数据，不用公开）；不想开源自己的修改，购买商用授权，见 [`COMMERCIAL.md`](COMMERCIAL.md)。贡献代码前须签贡献者协议，见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

本项目由**王铖运营社（STC）**维护。企业合作见[《合作与商用授权》](COMMERCIAL.md)。
