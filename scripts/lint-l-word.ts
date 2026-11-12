/**
 * 铁律 lint：**给人看的文案**里不许出现段位 L1–L5 或"能力段位"（需求 1.3）
 *
 * 违反后果：造出一批"纸上谈兵的 L4"——七力漂亮、真实商机零推进。
 *
 * ★ 项目里有两个不同的 L，别搞混 ★
 *   ① 段位 L1–L5      —— v6.0 的能力段位。**这是被禁的那个**
 *   ② 判定层 L1/L2/L3 —— 技术方案 4.1 三层判定体系（纯代码/结构化抽取/自由评分）。
 *      这是工程术语，出现在注释和技术讨论里完全正当。
 * 所以扫描时按上下文区分：出现在工程语境词附近的，放行。
 *
 * 扫两处：源码里的用户可见文案 + 数据库里已生成的报告。
 * CI 里这条应当是硬失败。
 */

import 'dotenv/config';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BAD = /\bL[1-5]\b|能力段位/;

/** 三层判定体系的语境词——命中说明这行说的是判定层，不是段位 */
const ENGINEERING_CONTEXT =
  /判定|纯代码|可靠性|三层|抽取|自由评分|硬否决|复核|层级|不许|禁止|铁律|作废|降成|白写/;

/** 这些文件整体豁免：它们的职责就是解释"为什么禁止" */
const ALLOW_FILES = [
  'scripts/lint-l-word.ts',
  'src/lib/report.ts',
  'src/lib/exam.ts', // 结论文案守卫本身，正则里必然出现被禁的模式
  'src/lib/p3.test.ts', // 守卫的测试，用例里必须写出反例
  // ★ 2026-08-25 新增两份守卫测试 ★ 和 p3.test.ts 同一个道理：
  // 要验证 assertConclusionClean / assertNoLGrade 拦不拦得住，用例里就必须真的写出
  // 「已达到 L2」这种反例。豁免的是测试文件，不是产品文案——
  // 这两份测试反过来正是在保证禁令生效，比不写它们更安全。
  'src/lib/exam.test.ts',
  'src/lib/report.test.ts',
];

let bad = 0;

function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.next', '.git', 'coverage'].includes(name)) continue;
    const p = join(dir, name);
    const rel = p.slice(ROOT.length + 1).split('\\').join('/');
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.(ts|tsx|css)$/.test(name)) continue;
    if (ALLOW_FILES.includes(rel)) continue;

    readFileSync(p, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!BAD.test(line)) return;
        if (ENGINEERING_CONTEXT.test(line)) return; // 说的是判定层，放行
        console.log(`✗ ${rel}:${i + 1}　${line.trim().slice(0, 100)}`);
        bad += 1;
      });
  }
}

walk(join(ROOT, 'src'));

// ★ 最要紧的一处：已经生成给人看的报告 ★
// 没配数据库（刚克隆下来的仓库、外部贡献者）就只查源码：没有报告可查，不该让整个 verify 失败
let reports: { sessionId: string; reportMd: string | null }[] | null = null;
if (process.env.DATABASE_URL) {
  const prisma = new PrismaClient();
  try {
    reports = await prisma.score.findMany({ select: { sessionId: true, reportMd: true } });
  } catch {
    console.log('· 连不上数据库，跳过已生成报告的检查（只查源码）');
  } finally {
    await prisma.$disconnect();
  }
} else console.log('· 没配数据库（DATABASE_URL），跳过已生成报告的检查（只查源码）');
for (const r of reports ?? []) {
  const hit = r.reportMd?.match(BAD);
  if (hit) {
    console.log(`✗ 报告 ${r.sessionId}：出现「${hit[0]}」`);
    bad += 1;
  }
}

console.log(
  bad === 0
    ? `✓ 通过：源码用户文案${reports ? `与 ${reports.length} 份已生成报告` : ''}均无段位 L 表述`
    : `✗ 共 ${bad} 处违规`,
);
process.exit(bad === 0 ? 0 : 1);
