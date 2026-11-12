/**
 * 库里的题型与标准层考纲是否一致（`npm run check:syllabus`）。
 *
 * 题型行（Persona）由题库装入器按考纲写，正常情况下不会偏离。这道检查防的是：
 *   · 有人绕过装入器直接写库；
 *   · 考纲升级了（改了某一型的名字、考点、七力），但库里还是旧的。
 *
 * 只检查**当前题库里有题的**题型。v8.2 之前的旧题型行（P1–P32）还在库里给历史局用，不在检查范围内。
 * 退出码非 0 ＝ 有问题。
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { SYLLABUS, SYLLABUS_VERSION, syllabusType } from '../standards/index';

const prisma = new PrismaClient();
const sameSet = (a: unknown, b: string[]) =>
  Array.isArray(a) && a.length === b.length && [...a].sort().join() === [...b].sort().join();

async function main(): Promise<number> {
  console.log(`考纲 v${SYLLABUS_VERSION}（${SYLLABUS.types.length} 个题型）\n`);
  const rows = await prisma.persona.findMany({
    where: { variants: { some: { active: true } } },
    include: { _count: { select: { variants: { where: { active: true } } } } },
    orderBy: { code: 'asc' },
  });
  let bad = 0;
  for (const row of rows) {
    const t = syllabusType(row.code);
    const problems: string[] = [];
    if (!t) problems.push('不在考纲里');
    else {
      if (row.name !== t.name) problems.push(`名称「${row.name}」应为「${t.name}」`);
      if (row.tests !== t.tests) problems.push('考点与考纲不一致');
      if (row.sessionType !== (t.session_type === 'followup' ? 'FOLLOWUP' : 'INQUIRY')) problems.push('局型与考纲不一致');
      if (!sameSet(row.activeForces, t.active_forces)) problems.push('参与评分的力与考纲不一致');
      if (!sameSet(row.naForces, t.na_forces)) problems.push('不考的力与考纲不一致');
      if (row.syllabus !== `v${SYLLABUS_VERSION}`) problems.push(`记录的考纲版本是「${row.syllabus}」`);
    }
    if (problems.length) {
      bad += 1;
      console.log(`✗ ${row.code} ${row.name}（${row._count.variants} 道题）：${problems.join('；')}`);
    }
  }
  console.log(
    bad
      ? `\n✗ ${bad} 个题型与考纲不一致。考纲升级后，请装入按新考纲打包的题库版本`
      : `✓ 当前题库用到的 ${rows.length} 个题型全部与考纲一致`,
  );
  return bad ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .finally(() => prisma.$disconnect());
