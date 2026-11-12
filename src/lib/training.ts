/**
 * 结构化训练任务的**外壳**：取数、写库、加锁。
 *
 * ★ 判定不在这里 ★（2026-08-25 拆分）「算不算有效练习局」「该派哪道题」
 * 两段判定搬进了 `training-decide.ts`——那是纯函数、有测试、受无菌区守卫看管。
 * 这个文件只负责把料备齐交给它，再把结论落库。要改规则请改内核并补测试，
 * 不要在这里就地判一下——那正是它们过去没法测的原因。
 */
import { prisma } from './db';
import { businessDay } from './business-day';
import {
  buildTrainingPlan,
  isValidTrainingSession,
  rankTrainingCandidates,
  slotVariantFilter,
  trainingCycleId,
  type TaskSlot,
} from './training-decide';
import { initialState } from '../../engine/state-machine';
import { emptyFacts } from '../../engine/facts';
import { emptyUnlockState } from '../../engine/unlock';
import { currentDifficultyFactor } from './difficulty-setting';

export const V3_SCORE_RULE_VERSION = 'v3.0-admission-20260815';

// 计划表定义在内核里；这里 re-export，外部 import 路径不用改
export { BASELINE_TRAINING_PLAN } from './training-decide';

export async function ensureAdmissionTrainingPlan(userId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.employeeType !== 'INTERN' || user.participationMode !== 'ADMISSION') {
      throw new Error('只有实习业务员的准入模式会生成结构化训练任务');
    }

    const startDay = user.trainingStartDay ?? businessDay();
    const cycleId = trainingCycleId(user.code, startDay);
    const existing = await tx.trainingTask.findMany({ where: { userId, cycleId }, orderBy: { orderNo: 'asc' } });
    if (existing.length > 0) return existing;

    if (!user.trainingStartDay) {
      await tx.user.update({ where: { id: userId }, data: { trainingStartDay: startDay } });
    }
    await tx.trainingTask.createMany({
      data: buildTrainingPlan().map((item) => ({ userId, cycleId, ...item })),
    });
    return tx.trainingTask.findMany({ where: { userId, cycleId }, orderBy: { orderNo: 'asc' } });
  });
}

async function pickTrainingVariant(userId: string, slot: TaskSlot, requiresBg: boolean) {
  const candidates = await prisma.personaVariant.findMany({
    where: {
      poolType: 'DRILL',
      active: true,
      // ★ 变体级筛选，不是骨架级 ★ 难度可能挂在变体上（2026-08-28 下沉），
      // 只按骨架筛会把覆盖过的题派进错误的槽位，而且不报错。见 slotVariantFilter
      ...slotVariantFilter(slot),
      ...(requiresBg ? { bgPackage: { isNot: null } } : {}),
    },
    include: { persona: true, bgPackage: true },
    orderBy: { variantId: 'asc' },
  });
  if (candidates.length === 0) throw new Error(`练习池没有可用的 ${slot} 题`);

  const history = await prisma.session.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { variantId: true, createdAt: true },
  });
  // 业务日换算要读时钟，留在外壳；剔重与排序交给内核
  const today = businessDay();
  const usedTodayIds = history.filter((item) => businessDay(item.createdAt) === today).map((item) => item.variantId);
  const useCount = new Map<string, number>();
  history.forEach((item) => useCount.set(item.variantId, (useCount.get(item.variantId) ?? 0) + 1));

  const ranked = rankTrainingCandidates({ candidates, usedTodayIds, useCount });
  if (ranked.length === 0) throw new Error(`今天的 ${slot} 候选都已经练过，同一变体同一天不能重复计任务`);
  return ranked[0]!;
}

export async function startTrainingTask(user: { id: string; code: string }, taskId: string) {
  const task = await prisma.trainingTask.findUnique({ where: { id: taskId } });
  if (!task || task.userId !== user.id) throw new Error('找不到你的这项训练任务');
  if (task.sessionId) return prisma.session.findUniqueOrThrow({ where: { id: task.sessionId } });
  if (task.status !== 'UNLOCKED') throw new Error('这项任务尚未解锁');

  const variant = await pickTrainingVariant(user.id, task.slotType, task.requiresBg);
  const init = variant.initState as { interest?: number };
  const day = businessDay();

  // 系数在事务外读：它是一次独立查询，没必要占着行锁
  const difficultyFactor = await currentDifficultyFactor();

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TrainingTask" WHERE id = ${taskId} FOR UPDATE`;
    const locked = await tx.trainingTask.findUniqueOrThrow({ where: { id: taskId } });
    if (locked.sessionId) return tx.session.findUniqueOrThrow({ where: { id: locked.sessionId } });
    if (locked.status !== 'UNLOCKED') throw new Error('这项任务尚未解锁');

    const seq = (await tx.session.count({ where: { userId: user.id } })) + 1;
    const session = await tx.session.create({
      data: {
        drillId: `D-${user.code}-${variant.variantId}-${day.replaceAll('-', '')}-${String(seq).padStart(2, '0')}`,
        userId: user.id,
        variantId: variant.id,
        type: variant.persona.sessionType,
        mode: 'DRILL',
        state: initialState(init.interest ?? 70) as unknown as object,
        facts: emptyFacts((variant.presetElements ?? []) as string[]) as unknown as object,
        unlockState: emptyUnlockState() as unknown as object,
        // ★ 开局就把难度系数钉在局上 ★ 跑局时读的是这一份快照，不是"当前设置"——
        // 主管中途改系数不许影响正在跑的局，判定也要知道每一局按哪个系数打的。
        difficultyFactor,
      },
    });
    await tx.trainingTask.update({ where: { id: taskId }, data: { sessionId: session.id } });
    return session;
  });
}

/** 评分完成后调用：完成当前任务并按顺序解锁下一项；无效局只补测，不记失败。 */
export async function refreshAssignedTaskCompletion(sessionId: string): Promise<void> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      messages: true,
      coachQa: true,
      score: true,
      trainingTask: true,
      variant: true,
    },
  });
  if (!session) return;
  const valid = isValidTrainingSession(session);

  if (session.trainingTask) {
    await prisma.$transaction(async (tx) => {
      const task = session.trainingTask!;
      if (task.status === 'COMPLETED' || task.status === 'INVALID') return;
      if (valid) {
        await tx.trainingTask.update({ where: { id: task.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
        const next = await tx.trainingTask.findFirst({
          where: { userId: task.userId, cycleId: task.cycleId, status: 'PENDING' },
          orderBy: { orderNo: 'asc' },
        });
        if (next) await tx.trainingTask.update({ where: { id: next.id }, data: { status: 'UNLOCKED' } });
      } else {
        await tx.trainingTask.update({ where: { id: task.id }, data: { status: 'INVALID' } });
        const max = await tx.trainingTask.aggregate({ where: { userId: task.userId, cycleId: task.cycleId }, _max: { orderNo: true } });
        await tx.trainingTask.create({
          data: {
            userId: task.userId,
            cycleId: task.cycleId,
            orderNo: (max._max.orderNo ?? task.orderNo) + 1,
            taskType: task.taskType,
            slotType: task.slotType,
            requiresBg: task.requiresBg,
            sourceAttemptId: task.sourceAttemptId,
            reason: '上一局未达到有效练习局条件，补测同类场景',
            status: 'UNLOCKED',
          },
        });
      }
    });
  }
}

/*
 * ★ 这里原来还有一个 `ensureRemedialTasks()`（考试后的定向补强 / 暂停后的恢复训练）★
 * 2026-08-24 删。它唯一的调用点是 `redline-review.settleV3Attempt`——
 * v3.0 的双组准入判定，而那套判定从 v1.1 起就不再决定任何人的资格，也随之删掉了。
 *
 * ★ 要把「弱项派题」做回来的话，别照抄它 ★ 它派题的依据是 v3 五闸门的 failedRules
 * 字符串（靠 `reason.includes('空催')` 这种匹配挑槽位）。v1.1 的判定只有局分一条，
 * 根本产不出那种字符串——真要派题，输入应该是七力最低项和红线代号，不是判定文案。
 */
