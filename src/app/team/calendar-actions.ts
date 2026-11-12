'use server';

/**
 * 工作日历与请假的写操作（2026-08-21，王老师定：放假要能豁免）
 *
 * ★ 只有一个动作：把某一天标成「和默认不一样」★
 * 默认是周一至周五上班、周末休息。点一个周四 → 放假；点一个周六 → 调休上班。
 * 两者不是两个功能，是同一个开关落在不同默认值上的结果——
 * 界面上就该只有一个日历，点哪天算哪天。
 *
 * ★ 只有主管进得来 ★ 每个 action 都自己查一遍身份——
 * 页面上藏起来不算权限，接口能被直接调。
 */

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requireUser, canSeeEveryone } from '@/lib/current-user';
import { businessDay } from '@/lib/business-day';
import { resettleRange } from '@/lib/settlement';
import { audit } from '@/lib/admin-audit';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function refresh() {
  revalidatePath('/team');
  revalidatePath('/replay');
  revalidatePath('/');
  revalidatePath('/exam');
}

/**
 * 设一天的上班状态。
 *
 * @param isWorkday true=调休上班｜false=放假｜**null=退回默认**（把这条例外删掉）
 *
 * ★ 和默认一样就不存 ★ 日历表只存例外。若存了一堆「和默认一样」的行，
 * 「没维护」和「维护过、确认是工作日」在数据上就分不开了。
 */
export async function setCalendarDay(day: string, isWorkday: boolean | null) {
  const me = await requireUser();
  if (!canSeeEveryone(me)) return;
  if (!DAY_RE.test(day)) return;
  const was = await prisma.businessCalendar.findUnique({ where: { day }, select: { isWorkday: true } });
  if (isWorkday === null) {
    await prisma.businessCalendar.delete({ where: { day } }).catch(() => null);
  } else {
    await prisma.businessCalendar.upsert({
      where: { day },
      update: { isWorkday, setBy: me.id, setAt: new Date() },
      create: { day, isWorkday, setBy: me.id },
    });
  }
  // ★ 每一次都记 ★ 表上的 setBy/setAt 只记得住「最后一次是谁改的」，
  // 改过又改回来就看不出了；流水记的是每一次，两者不重复。
  const say = (v: boolean | null | undefined) =>
    v === null || v === undefined ? '默认（周一至周五上班）' : v ? '调休上班' : '放假';
  await audit({
    actorId: me.id,
    action: 'CALENDAR_SET',
    before: `${day} ${say(was?.isWorkday)}`,
    after: `${day} ${say(isWorkday)}`,
    note: '改了日历要不要重算历史，看面板上的留档体检',
  });
  refresh();
}

/**
 * 设某人某天的请假。
 * @param reason 事由（病假/事假/出差…）｜**null=撤销**
 *
 * 请假那天对**这个人**不是业务日：不要求演习与考试、不判定，
 * 台账那一行写「请假」而不是「缺考」——一个是批过的，一个是没来。
 */
export async function setLeaveDay(code: string, day: string, reason: string | null) {
  const me = await requireUser();
  if (!canSeeEveryone(me)) return;
  if (!DAY_RE.test(day) || !code) return;
  const target = await prisma.user.findUnique({ where: { code }, select: { id: true } });
  if (!target) return;
  const was = await prisma.leaveDay.findUnique({
    where: { userId_day: { userId: target.id, day } },
    select: { reason: true },
  });
  if (reason === null) {
    await prisma.leaveDay.deleteMany({ where: { userId: target.id, day } });
  } else {
    await prisma.leaveDay.upsert({
      where: { userId_day: { userId: target.id, day } },
      update: { reason, setBy: me.id, setAt: new Date() },
      create: { userId: target.id, day, reason, setBy: me.id },
    });
  }
  await audit({
    actorId: me.id,
    subjectId: target.id,
    action: 'LEAVE_SET',
    before: was ? `${day} ${was.reason ?? '请假'}` : `${day} 正常上班`,
    after: reason === null ? `${day} 正常上班（撤销请假）` : `${day} ${reason}`,
  });
  refresh();
}

/**
 * 重算：把某天起到昨天为止的每日结算按**当前日历**重新跑一遍。
 *
 * ★ 为什么不在标日历时自动跑 ★ 它会真的改人的期别与分配权。
 * 一个手滑点错的日期若立刻连带改状态，等于让一次误操作直接停掉某人的询盘。
 * 所以做成显式按钮：先标日历，看清楚了再点重算。
 */
export async function resettleFrom(from: string) {
  const me = await requireUser();
  if (!canSeeEveryone(me)) return;
  if (!DAY_RE.test(from) || from >= businessDay()) return;
  // ★ 带上操作人 ★ 重算重放出来的 AccessDecision 和定时任务写的长得一模一样，
  // 不标一句，事后翻台账分不出「系统判的」和「谁点了重算」。
  const done = await resettleRange(from, { trigger: `${me.name}（${me.code}）从 ${from} 起重算` });
  await audit({
    actorId: me.id,
    action: 'RESETTLE',
    after: `从 ${from} 起重算，跑了 ${done.days} 个业务日 × ${done.users} 人${done.through ? `，到 ${done.through} 为止` : ''}`,
    note: done.truncated
      ? `没跑完——撞上一次最多 40 个业务日的上限，还要从 ${done.resumeFrom} 再点一次`
      : '这一段留档已按当前日历重放，期别与分配权跟着改了',
  });
  refresh();
}
