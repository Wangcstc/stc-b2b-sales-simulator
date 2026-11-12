# 样品（虚构数据）

发布包里**唯一**带的题。一家虚构的户外露营用品工厂：三款产品、8 份虚构的阿里国际站聊天导出件、按模板填好的产品表与公司信息表，以及由它们手工打磨出来的 8 道题。

**所有人名、公司、邮箱都是虚构的**，邮箱一律用保留域名 `.example`，不对应任何真实的人或公司。

## 三个用途

1. **试玩**：新装好的系统没有题，先装样品题库就能打一局。
   ```bash
   npm run bank -- load samples/bank
   ```
   演习装上就能练。考试要每个槽位 ≥14 道、≥4 个题型，样品只有 8 道题凑不够；想试考试，在 `.env` 里把
   `POOL_EXAM_SLOT_MIN_QUESTIONS`、`POOL_EXAM_SLOT_MIN_TYPES` 都填 1，**正式使用前删掉**。
2. **照着投料**：`raw-materials/` 就是一家公司该交的全部原材料，拿它走一遍投料到上架的流程。
3. **金标准**：抽屉每次改动后，用样品原材料重新加工，和这里的题对比，防止质量倒退。

## 目录

| 目录 | 是什么 | 怎么来的 |
|---|---|---|
| `raw-materials/chats/` | 8 份虚构聊天导出件（HTML） | 手写 |
| `raw-materials/产品表-样品.xlsx`、`公司信息-样品.xlsx` | 按原材料模板填好的表 | `npm run samples:build` 从 `src/products.json`、`src/company.json` 填出 |
| `redacted/` | 供回归测试使用的虚构脱敏素材 | 来自虚构聊天，身份字段使用样品编号 |
| `src/` | 样品题的**真源**：题目、背调包、公司信息、产品目录、题库包身份信息 | 手工打磨 |
| `bank/` | 样品题库包 | `npm run samples:build` 从 `src/` 构建 |

## 8 道题

| 编号 | 题型 | 局型 / 难度 | 题池 | 产品 |
|---|---|---|---|---|
| A01-DE-001 | 配合探需型 | 探需 / 简单 | 演习 | 折叠椅 |
| A02-US-001 | 只问价格型 | 探需 / 标准 | 演习 | 露营灯 |
| A03-GB-001 | 身份存疑型（带背调包） | 探需 / 困难 | 演习 | 睡垫 |
| A09-SE-001 | 技术尽调型 | 探需 / 标准 | 考试 | 露营灯 |
| B01-PL-001 | 极限压价型 | 探需 / 困难 | 考试 | 折叠椅 |
| B03-AU-001 | 报价沉默型 | 跟进 / 标准 | 考试 | 睡垫 |
| C02-CA-001 | 样品沉默型 | 跟进 / 标准 | 演习 | 露营灯 |
| E01-GB-001 | 售后纠纷型 | 跟进 / 困难 | 演习 | 折叠椅 |

考试三个槽位（探需·标准 / 探需·困难 / 跟进）各有 1 道。

## 改样品

**只改 `src/`，然后 `npm run samples:build`。** `bank/` 是构建产物，`npm run check:samples`（已并入 `npm run verify`）会核对两者一致。
改了题目要升 `src/bank.json` 里的 `bank_version`。每道题都要过四道闸，见 `docs/操作单/人设编写须知.md`：

```bash
npm run bank -- validate samples/bank
npx tsx scripts/import/verify-persona.ts samples/src/personas/<题目>.json
npx tsx scripts/import/verify-fidelity.ts samples/src/personas --materials=samples/redacted --strict
npx tsx scripts/import/autoplay.ts samples/src/personas
```
