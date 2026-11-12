import 'dotenv/config';

/**
 * 留档体检自检（2026-08-22）
 *
 * ★ 为什么要有这么个脚本 ★ `loadLedgerAudit()` 只在账号管理页里被调用，
 * 而那一页要登录才进得去——纯函数部分有单测，取数这一层却没人跑过。
 * 这个脚本**只读**，直接调它一次，把结果打出来，顺带看清当前库里到底有没有对不上的留档。
 *
 * 用法：npx tsx scripts/check-ledger-audit.ts
 */

import { prisma } from '../src/lib/db';
import { businessDay } from '../src/lib/business-day';
import { loadLedgerAudit, STALE_LABEL } from '../src/lib/ledger-audit';

const today = businessDay();
const audit = await loadLedgerAudit();

// ★ 先报样本量 ★ 不报的话，「全部对得上 ✓」和「库里一行留档都没有」长得一模一样，
// 而后者说明的是别的问题（结算没跑过），不是「一切正常」。
const [scanned, users, marks, leaves] = await Promise.all([
  prisma.dailyEvaluation.count({ where: { day: { lt: today } } }),
  prisma.user.count({ where: { employeeType: 'INTERN', participationMode: 'ADMISSION', disabledAt: null } }),
  prisma.businessCalendar.count(),
  prisma.leaveDay.count(),
]);

console.log(`今天（上海业务日）：${today}`);
console.log(`样本：留档 ${scanned} 行 · 在册实习业务员 ${users} 人 · 日历例外 ${marks} 天 · 请假 ${leaves} 天`);
console.log(`留档体检：${audit.dayCount === 0 ? '全部对得上 ✓' : `${audit.dayCount} 天对不上`}`);

if (audit.dayCount > 0) {
  console.log(`重算起点：${audit.from}`);
  for (const [reason, count] of Object.entries(audit.byReason)) {
    if (count > 0) console.log(`  · ${reason}（${STALE_LABEL[reason as keyof typeof STALE_LABEL]}）：${count} 条`);
  }
  const names = new Map(
    (await prisma.user.findMany({ select: { id: true, name: true, code: true } })).map((u) => [
      u.id,
      `${u.name}(${u.code})`,
    ]),
  );
  console.log('明细（最多 20 条）：');
  for (const item of audit.stale.slice(0, 20)) {
    console.log(`  ${item.day}  ${names.get(item.userId) ?? item.userId}  ${item.reason}`);
  }
  if (audit.stale.length > 20) console.log(`  …… 另有 ${audit.stale.length - 20} 条`);
}

await prisma.$disconnect();
