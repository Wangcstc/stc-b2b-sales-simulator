/**
 * 基础数据：建主管账号、对齐主管身份（本地跑法）。**不灌任何题**——题目用 `npm run bank -- load` 装入题库包。
 *
 * ★ 逻辑不在这里，在 src/lib/seed-core.ts ★ 云端那条路（/api/admin/bootstrap）用同一套。
 *
 * 用法：
 *   npm run seed                      # 本地 .env 里的库
 *   DATABASE_URL="..." npm run seed   # 指定的库
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { runSeed } from '../src/lib/seed-core.js';

const prisma = new PrismaClient();
const log = await runSeed(prisma);
for (const line of log) console.log(line);
console.log('\n基础数据就绪。题目请用 npm run bank -- load <题库包目录> 装入。');
await prisma.$disconnect();
