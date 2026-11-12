/**
 * 上线前门槛（`npm run check:readiness`）：有没有题可练、账号身份对不对；考试池够不够开考单独提示。
 * 题池门槛与开考时用的是同一份（`src/lib/exam.ts`，默认值来自标准层 `standards/pool-requirements.json`）。
 *
 * ★ 考试池没凑齐不算上线失败 ★ 题有多少用多少：演习有 1 道就能练，考试凑齐前只是开不了考。
 * 所以考试池的缺口单独列成「考试暂未开放」，不让整个检查报失败。
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { DRILL_POOL_MIN, EXAM_POOL_HEALTH } from '../src/lib/exam.js';

const prisma = new PrismaClient();
const failures: string[] = [];
/** 考试池缺口：提示，不算失败 */
const examGaps: string[] = [];

/** 与开考抽题同一口径：题目自己的难度覆盖优先，没写才跟题型 */
function slotOf(item: { difficulty: string | null; persona: { sessionType: string; difficulty: string } }) {
  if (item.persona.sessionType === 'FOLLOWUP') return 'FOLLOWUP';
  const d = item.difficulty ?? item.persona.difficulty;
  if (d === 'hard') return 'HARD_INQUIRY';
  if (d === 'standard') return 'STANDARD_INQUIRY';
  return 'OTHER';
}

async function main() {
  const variants = await prisma.personaVariant.findMany({
    where: { active: true },
    include: { persona: true },
  });
  const drill = variants.filter((item) => item.poolType === 'DRILL');
  const admission = variants.filter((item) => item.poolType === 'ADMISSION_EXAM');

  if (drill.length < DRILL_POOL_MIN) failures.push(drill.length ? `练习池 ${drill.length}/${DRILL_POOL_MIN}` : '练习池一道题都没有：先装入题库包');
  // 正式业务员的周考与实习业务员的准入考试抽同一个准入池。
  for (const [name, pool] of [['准入考试池', admission]] as const) {
    for (const slot of ['STANDARD_INQUIRY', 'HARD_INQUIRY', 'FOLLOWUP'] as const) {
      const inSlot = pool.filter((item) => slotOf(item) === slot);
      const types = new Set(inSlot.map((item) => item.persona.code)).size;
      if (inSlot.length < EXAM_POOL_HEALTH.minVariantsPerSlot) examGaps.push(`${name} ${slot} 题数 ${inSlot.length}/${EXAM_POOL_HEALTH.minVariantsPerSlot}`);
      if (types < EXAM_POOL_HEALTH.minPersonasPerSlot) examGaps.push(`${name} ${slot} 题型数 ${types}/${EXAM_POOL_HEALTH.minPersonasPerSlot}`);
    }
    const versions = new Set(pool.map((item) => item.poolVersion));
    // 考试池还空着就不谈版本（缺口已在上面提示）
    if (pool.length > 0 && versions.size !== 1) failures.push(`${name} 活动版本数为 ${versions.size}，要求恰好 1 个`);
  }

  const compatibilityMismatch = variants.filter(
    (item) => item.examOnly !== (item.poolType === 'ADMISSION_EXAM'),
  );
  if (compatibilityMismatch.length > 0) failures.push(`examOnly 兼容标记错位 ${compatibilityMismatch.length} 份`);

  const unconfirmedUsers = await prisma.user.findMany({
    where: { disabledAt: null, identityConfirmedAt: null },
    select: { code: true, name: true },
  });
  if (unconfirmedUsers.length > 0) {
    failures.push(`仍有 ${unconfirmedUsers.length} 个在用业务员账号未确认身份：${unconfirmedUsers.map((user) => `${user.name}(${user.code})`).join('、')}`);
  }

  const wrongRegular = await prisma.user.count({
    where: {
      disabledAt: null,
      employeeType: 'REGULAR',
      OR: [{ participationMode: { not: 'WEEKLY_EXAM' } }, { inquiryAccessStatus: { not: 'NOT_APPLICABLE' } }],
    },
  });
  if (wrongRegular > 0) failures.push(`${wrongRegular} 个正式业务员账号的参与模式或询盘权限口径错误`);

  console.log(`练习池 ${drill.length}｜准入池 ${admission.length}`);
  if (examGaps.length > 0) {
    console.log('⚠ 考试暂未开放（演习照常可用；凑齐前实习业务员开不了考）：');
    examGaps.forEach((gap) => console.log(`- ${gap}`));
    console.log('  用抽屉继续投聊天补题，打包时会提示每个槽位还差什么');
  }
  if (failures.length > 0) {
    console.error('上线门槛未通过：');
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exitCode = 1;
  } else {
    console.log('✓ 题池、版本与账号身份门槛全部通过');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
