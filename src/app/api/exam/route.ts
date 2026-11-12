import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { settleExam } from '@/lib/redline-review';
import { initialState } from '../../../../engine/state-machine';
import { emptyFacts } from '../../../../engine/facts';
import { emptyUnlockState } from '../../../../engine/unlock';
import { getCurrentUser, canSeeEveryone, type CurrentUser } from '@/lib/current-user';
import { businessDay } from '@/lib/business-day';
import { expireStaleAttempts } from '@/lib/exam-expiry';
import { ADMISSION_CONFIG, examGateOf, unlockState, type Stage } from '@/lib/admission-v11';
import { catchUpSettlement, countDrillsToday, previewWindow } from '@/lib/settlement';
import { examTrackOf, type ExamTrack } from '@/lib/exam-track';
import { EXAM_POOL_HEALTH, EXAM_SLOTS, examSlotOf, pickSlotVariant } from '@/lib/exam';
import { variantDifficulty } from '@/lib/variant-difficulty';
import { catchUpWeeks, loadWeekRecords, previewWeek } from '@/lib/weekly-settlement';
import { WEEKLY_EXAM_CONFIG } from '@/lib/weekly-exam';
import { V3_SCORE_RULE_VERSION } from '@/lib/training';
import { currentDifficultyFactor } from '@/lib/difficulty-setting';

/**
 * 考试闸门 v1.1
 *
 * ★ 每人每天 1 场，3 局 ★ 训练期和在岗期考的是同一种考试，
 * 区别只在开考前置条件：训练期当日要先练够 3 局演习，在岗期不要求。
 *
 * ★ 2026-08-24 起两条轨共用这一套 ★ 实习业务员（准入轨）与正式业务员（周考轨）
 * 开的是同一种考试、抽的是同一个 ADMISSION_EXAM 池、用的是同一把评分尺子。
 * 分流只在两处：① 周考轨不查「当日先练 3 局」；② 结算落到哪张表
 * （准入轨 → DailyEvaluation，周考轨 → WeeklyExamRecord）。
 *
 * ★ 这里不再产出「通过／不通过」★ 判定是最近 6 局的滚动窗口，每晚结算，
 * 见 lib/settlement.ts。本路由只负责：能不能开考、开哪三局、交卷小结。
 */

const POOL_TYPE = 'ADMISSION_EXAM' as const;

/**
 * ★ 分档口径搬去 lib/exam.examSlotOf 了 ★ 教练台那份并了进去，全站只剩一份。
 * ★ 难度先解析再分槽 ★（2026-08-28 下沉之后）变体可以覆盖骨架的档位，
 * 直接把 persona 传进去会漏掉覆盖——表现是这份题被分进错误的槽位，而且不报错。
 */
const slotOf = (candidate: { difficulty?: string | null; persona: { sessionType: string; difficulty: string } }) =>
  examSlotOf({ sessionType: candidate.persona.sessionType, difficulty: variantDifficulty(candidate) });

async function pickAdmissionVariants(userId: string) {
  const all = await prisma.personaVariant.findMany({
    where: { poolType: POOL_TYPE, active: true },
    include: { persona: true },
  });
  const versions = [...new Set(all.map((item) => item.poolVersion))];
  if (versions.length !== 1) {
    throw new Error(`准入考试池存在 ${versions.length} 个活动版本；上线时只能启用一个完整版本`);
  }
  const poolVersion = versions[0];
  if (!poolVersion) throw new Error('准入考试池为空，禁止自动回退练习池');
  const pool = all.filter((candidate) => slotOf(candidate) !== null);
  for (const required of EXAM_SLOTS) {
    const slotPool = pool.filter((candidate) => slotOf(candidate) === required);
    if (slotPool.length < EXAM_POOL_HEALTH.minVariantsPerSlot) {
      throw new Error(
        `准入考试池 ${required} 只有 ${slotPool.length}/${EXAM_POOL_HEALTH.minVariantsPerSlot} 份，未达到上线硬门槛`,
      );
    }
    // ★ 第二条硬门槛：按考点算 ★（2026-08-28）
    // 14 份题可以全部来自 3 个考点——那不是抽题，是轮流，第三天就开始重复考点。
    // 告警线（targetPersonasPerSlot）在教练台上喊，这里只拦最下面那一档。
    const personas = new Set(slotPool.map((candidate) => candidate.persona.code));
    if (personas.size < EXAM_POOL_HEALTH.minPersonasPerSlot) {
      throw new Error(
        `准入考试池 ${required} 只有 ${personas.size} 个考点（下限 ${EXAM_POOL_HEALTH.minPersonasPerSlot}）。` +
          `份数够不代表池子够——同一个考点的不同化身防不了背题，要补的是考点，不是变体。`,
      );
    }
  }

  /**
   * ★ 防重复看的是「他这辈子见过的」，不是「最近 14 局」★（2026-08-28 改）
   *
   * 原来是 `take: 14`：一个人每天考 3 局，14 局 ≈ 4.7 天，**第 5 天前面的题就解禁了**。
   * 而且那 14 局里混着演习局——演习局用的是另一个池，白白占掉防重复的名额，
   * 实际能挡住的比 5 天还短。
   *
   * 现在只数考试局、且不设上限：该槽 14 份全部见完才重置（重置逻辑在下面），
   * 于是每槽每天用一份 → **14 个考试日不重题**。
   */
  const seen = await prisma.session.findMany({
    where: { userId, mode: 'ADMISSION_EXAM' },
    select: { variantId: true },
  });
  const recentIds = new Set(seen.map((item) => item.variantId));

  const previousAttempt = await prisma.examAttempt.findFirst({
    where: { userId, attemptType: 'DAILY', verdict: { not: null } },
    orderBy: { createdAt: 'desc' },
  });
  const previousSessions = previousAttempt
    ? await prisma.session.findMany({
        where: { id: { in: previousAttempt.sessionIds } },
        include: { variant: { include: { persona: true } } },
      })
    : [];
  const previousSkeletons = new Set(previousSessions.map((session) => session.variant.persona.code));
  const currentSkeletons = new Set<string>();

  const picked = [] as typeof pool;
  for (const slot of EXAM_SLOTS) {
    const slotPool = pool.filter((candidate) => slotOf(candidate) === slot);
    const withoutSkeletonRepeat = slotPool.filter(
      (candidate) => !previousSkeletons.has(candidate.persona.code) && !currentSkeletons.has(candidate.persona.code),
    );
    const fresh = withoutSkeletonRepeat.filter((candidate) => !recentIds.has(candidate.id));
    // 该槽位全部见完之后，只重置"个人已见变体"；上一组和当前组骨架仍不得重复。
    const candidates = fresh.length > 0 ? fresh : withoutSkeletonRepeat;
    if (candidates.length === 0) {
      throw new Error(`${slot} 没有满足防重复约束的准入题；禁止回退练习池，请补足考试池`);
    }
    /**
     * ★ 先在考点里等概率，再在变体里等概率 ★（2026-08-28）
     * 直接在候选里随机会让变体多的考点多拿几张彩票——困难探需槽里
     * P19 有 6 份，于是 43% 的考试都在考它。理由与实测数字见 `pickSlotVariant`。
     */
    const selected = pickSlotVariant(
      candidates.map((candidate) => ({ id: candidate.id, personaCode: candidate.persona.code, candidate })),
    )!.candidate;
    picked.push(selected);
    currentSkeletons.add(selected.persona.code);
  }
  return { picked, poolVersion };
}

/**
 * 今天能不能开考。
 *
 * ★ 跨天没结算的场次不许把今天堵死 ★ 旧写法是「有未结算的考试就 resume」，
 * 于是一场忘了交卷的考试能永久占住这个人的考试位——他既考不了新的，
 * 状态也永远不会变。现在：能结算的自动结算，结算不了的作废，
 * 已经打完并评分的局照常进最近 6 局窗口，一局都不浪费。
 *
 * ★ 2026-08-28：这段逻辑搬去 lib/exam-expiry.ts 了 ★
 * 原来它只长在这里，而这里**只有点「开始今天的考试」才会走**——
 * 于是不点就不作废，昨天那场永远停在「进行中」，还能继续打。
 * 现在同一个函数每晚结算时全员扫一遍、打开考试闸门也扫一遍，这里是最后一道。
 */
async function determineAttempt(user: CurrentUser) {
  const today = businessDay();

  // 先把这个人跨天没收的场次收干净（能交卷的交卷，交不了的作废）
  await expireStaleAttempts({ userId: user.id, today });

  // 收完之后还剩的未结场次，只可能是今天这一场
  const running = await prisma.examAttempt.findFirst({
    where: { userId: user.id, attemptType: 'DAILY', verdict: null, businessDay: today },
    orderBy: { createdAt: 'desc' },
  });
  if (running) return { resume: running } as const;

  const todayAttempt = await prisma.examAttempt.findFirst({
    where: { userId: user.id, businessDay: today, attemptType: 'DAILY' },
  });
  if (todayAttempt) {
    throw new Error(
      examTrackOf(user) === 'WEEKLY'
        ? `今天这场考试已经考完了——每人每日 1 场。你的要求是每周至少 ${WEEKLY_EXAM_CONFIG.examsPerWeek} 场，明天接着考。`
        : '今天这场考试已经考完了——每人每日 1 场。判定用的是最近 6 局，不是今天这一场，明天接着考。',
    );
  }

  // ★ 「当日先练 3 局」只拦准入轨的训练期 ★（2026-08-24）
  // 与 examGateOf 里那道闸是同一条规则，按钮和接口必须读同一份判断
  if (examTrackOf(user) === 'ADMISSION' && user.stage === 'TRAINING') {
    const { done, nonSimple } = await countDrillsToday(user.id, today);
    const state = unlockState(done, 'TRAINING', nonSimple);
    if (!state.unlocked) {
      // ★ 局数满了却被拦，头一句必须说难度 ★（2026-08-23）
      // 沿用「还差 N 局」会让一个 3/3 的人以为系统坏了。
      const countShort = Math.max(0, state.required - done);
      throw new Error(
        [
          countShort > 0
            ? `今日演习 ${done} / ${state.required} 局，还差 ${countShort} 局才能开考。`
            : `今日演习 ${done} / ${state.required} 局已经够了，但三局不能全挑简单——还差 ${state.nonSimpleRequired - nonSimple} 局标准或困难。`,
          '',
          '去模拟询盘练。',
          '',
          `一局要聊满 ${ADMISSION_CONFIG.validDrillMinTurns} 轮、出了报告，并且真问出了东西才算数。`,
          '（至少解开一张暗牌，或至少问到一项六要素——寒暄、自我介绍、发目录都不算问。）',
          '如果你今天明明练过，进度却没涨——多半是有一局光聊没问。',
        ].join('\u000A'),
      );
    }
  }

  return { attemptType: 'DAILY' as const } as const;
}

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '请先在选人页选择你是谁' }, { status: 401 });
  // ★ 两条轨都放行 ★（2026-08-24）这里原来只认实习业务员，正式业务员一律 403，
  // 于是他既开不了考、又在版头看着「今日考试 未开始」——拦住了还骗人一下。
  if (examTrackOf(user) === null) {
    return NextResponse.json({ error: '当前账号不参加演习考试' }, { status: 403 });
  }

  try {
    const next = await determineAttempt(user);
    if ('resume' in next && next.resume) {
      return NextResponse.json({ id: next.resume.id, sessionIds: next.resume.sessionIds, resumed: true });
    }
    const { picked, poolVersion } = await pickAdmissionVariants(user.id);
    const day = businessDay();
    // 一场考试 3 局共用一个系数，事务外读一次
    const difficultyFactor = await currentDifficultyFactor();

    const created = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
      const duplicate = await tx.examAttempt.findFirst({
        where: { userId: user.id, businessDay: day, attemptType: 'DAILY' },
      });
      if (duplicate) return duplicate;
      const sessionIds: string[] = [];
      for (let index = 0; index < picked.length; index++) {
        const variant = picked[index]!;
        const init = variant.initState as { interest?: number };
        const session = await tx.session.create({
          data: {
            drillId: `D-${user.code}-EX-${day.replaceAll('-', '')}-${String(index + 1).padStart(2, '0')}`,
            userId: user.id,
            variantId: variant.id,
            type: variant.persona.sessionType,
            mode: 'ADMISSION_EXAM',
            state: initialState(init.interest ?? 70) as unknown as object,
            facts: emptyFacts((variant.presetElements ?? []) as string[]) as unknown as object,
            unlockState: emptyUnlockState() as unknown as object,
            // ★ 一场考试的 3 局用同一个系数 ★ 在循环外读一次，
            // 免得跨过午夜时三局落到两个不同的口径上——那三局是要一起算中位数的。
            difficultyFactor,
          },
        });
        sessionIds.push(session.id);
      }
      return tx.examAttempt.create({
        data: {
          userId: user.id,
          day,
          businessDay: day,
          attemptType: 'DAILY',
          groupNo: 1,
          scoreRuleVersion: V3_SCORE_RULE_VERSION,
          poolVersion,
          sessionIds,
        },
      });
    });

    return NextResponse.json({
      id: created.id,
      attemptType: created.attemptType,
      sessionIds: created.sessionIds,
      poolInfo:
        '开考瞬间 3 局全部生成好——可以关掉浏览器分次打，当天回来接着打，不会丢；但不能重开一场，也不要跨天。',
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 409 });
  }
}

/** 手动交卷小结。评分完成后系统已经自动结算过一次，这里只是补一个入口 */
export async function PUT(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '请先在选人页选择你是谁' }, { status: 401 });
  const { attemptId } = (await req.json()) as { attemptId?: string };
  if (!attemptId) return NextResponse.json({ error: '缺少 attemptId' }, { status: 400 });

  const attempt = await prisma.examAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt) return NextResponse.json({ error: '找不到这场考试' }, { status: 404 });
  if (attempt.userId !== user.id && !canSeeEveryone(user)) {
    return NextResponse.json({ error: '这不是你的考试' }, { status: 403 });
  }
  const unscored = await prisma.session.count({ where: { id: { in: attempt.sessionIds }, score: { is: null } } });
  if (unscored > 0) return NextResponse.json({ error: `还有 ${unscored} 局没评分，评完才能交卷` }, { status: 409 });

  const verdict = await settleExam(attemptId);
  if (!verdict) return NextResponse.json({ error: '交卷失败：有局评分不完整' }, { status: 409 });
  return NextResponse.json(verdict);
}

/**
 * 今天还能不能开考。
 *
 * ★ 按钮和接口必须读同一个判断 ★（2026-08-22 王老师：考完就锁住考试按钮）
 * 原来 POST 里拦得死死的，按钮却照样亮着写「开始今天的考试」——点下去才弹一句
 * 「今天这场考试已经考完了」。拦住了但骗了人一下，那不叫锁。
 *
 * ★ 2026-08-28：这里原来「只读，不做清理」★
 * 原注释写着「跨天没交卷那场的结算/作废仍然由 POST 的 determineAttempt 负责」——
 * 问题就出在这句：不点开考就永远不清理，于是考试记录里昨天那场一直挂着「进行中」，
 * 三局的「继续/评分」「开始这一局」照样能点。闸门读的是今天，记录列表读的是那一场，
 * 两边看的不是同一份事实。
 * 现在进这一页就地收一次（幂等，收干净了第二次是空扫），闸门和记录列表看到的是同一份。
 */
async function examGate(user: CurrentUser, today: string, track: ExamTrack) {
  if (track === null) {
    return examGateOf({ track: null, todayAttempt: 'none', stage: 'TRAINING', drillsToday: 0 });
  }
  const todayAttempt = await prisma.examAttempt.findFirst({
    where: { userId: user.id, businessDay: today, attemptType: 'DAILY' },
    select: { verdict: true },
  });
  // ★ 只有准入轨的训练期才需要数演习局 ★ 周考轨不查这个，省一次往返，
  // 也免得「今日演习 0/3」这种与他无关的数字被算出来又被丢掉
  const drills =
    track === 'ADMISSION' && user.stage === 'TRAINING'
      ? await countDrillsToday(user.id, today)
      : { done: 0, nonSimple: 0 };
  return examGateOf({
    track,
    todayAttempt: !todayAttempt ? 'none' : todayAttempt.verdict === null ? 'running' : 'done',
    stage: user.stage as Stage,
    drillsToday: drills.done,
    nonSimpleDrillsToday: drills.nonSimple,
  });
}

/**
 * 考试记录一页几场。
 * ★ 和 components/Pager.tsx 的 PAGE_SIZE 保持一致 ★ 那个文件是 'use client'，
 * 服务端不能直接引它的常量，所以这里写一份，改动要同批改。
 */
const RECORDS_PER_PAGE = 10;

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '请先在选人页选择你是谁' }, { status: 401 });
  const viewingAll = canSeeEveryone(user);
  const today = businessDay();
  const track = examTrackOf(user);
  const intern = track === 'ADMISSION';
  const weekly = track === 'WEEKLY';

  // 读页面顺手把漏掉的结算补上。幂等，且只处理已经过去的业务日。
  // ★ 两条轨各补各的账 ★ 准入轨补 DailyEvaluation，周考轨补 WeeklyExamRecord
  if (intern) await catchUpSettlement(user.id, today);
  if (weekly) await catchUpWeeks(user.id, today);
  /**
   * ★ 跨天没收的场次也在这儿一起收 ★（2026-08-28）
   * 必须排在下面那些查询**前面**：闸门、今天这一行、记录列表读的都是 ExamAttempt，
   * 收在后面的话这一次刷新看到的还是旧状态，得再刷一次才对——
   * 那正是「昨天那场一直挂着进行中」看起来像 bug 的原因之一。
   * ★ 只收自己的 ★ 主管翻别人的记录不该顺手改别人的数据；全员那一趟归每晚结算。
   */
  if (track !== null) await expireStaleAttempts({ userId: user.id, today });

  // ★ 分页在数据库做 ★ 主管视图是全员记录，一年下来几千场；
  // 全量拉回来再在前端切片，翻到第 2 页要等的是整张表。
  const asked = Math.max(1, Math.floor(Number(new URL(req.url).searchParams.get('page') ?? '1')) || 1);
  const scope = viewingAll ? undefined : { userId: user.id };
  const attemptsTotal = await prisma.examAttempt.count({ where: scope });
  // ★ 页码在这里夹住 ★ 越界就退到最后一页：记录被删、或有人手改 URL 时，
  // 页面拿到的不该是一页空白。夹完的页码随返回体回传，前端跟着它走。
  const page = Math.min(asked, Math.max(1, Math.ceil(attemptsTotal / RECORDS_PER_PAGE)));
  const attempts = await prisma.examAttempt.findMany({
    where: scope,
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * RECORDS_PER_PAGE,
    take: RECORDS_PER_PAGE,
    include: { user: true },
  });
  const sessions = await prisma.session.findMany({
    where: { id: { in: attempts.flatMap((attempt) => attempt.sessionIds) } },
    include: { score: true, variant: { include: { persona: true } } },
  });
  const sessionInfo = Object.fromEntries(
    sessions.map((session) => [
      session.id,
      {
        sessionType: session.variant.persona.sessionType,
        difficulty: variantDifficulty(session.variant),
        status: session.status,
        turn: (session.state as { turn?: number }).turn ?? 0,
        scored: Boolean(session.score),
        rawScore: session.score?.rawScore ?? null,
        tier: session.score?.tier ?? null,
      },
    ]),
  );

  // ★ 今天这场必须单独查 ★（2026-08-22）状态屏上的「今天这场」原来是从 attempts 里找的，
  // 记录一分页，翻到第 2 页那条就不在返回里了——屏上会把「已考完」显示成「未考」。
  const todayRow =
    track !== null
      ? await prisma.examAttempt.findFirst({
          where: { userId: user.id, businessDay: today, attemptType: 'DAILY' },
          select: { verdict: true, sessionIds: true },
        })
      : null;
  // 数已出分的局，不读 verdict —— 自动交卷允许失败，读它会把「考完了」说成「没考」
  const todayScored = todayRow
    ? await prisma.session.count({ where: { id: { in: todayRow.sessionIds }, score: { isNot: null } } })
    : 0;

  const drills = intern
    ? await countDrillsToday(user.id, today)
    : { done: 0, nonSimple: 0, started: 0 };
  const window = intern ? await previewWindow(user.id) : null;
  const evaluations = intern
    ? await prisma.dailyEvaluation.findMany({ where: { userId: user.id }, orderBy: { day: 'desc' }, take: 14 })
    : [];
  // ★ 周考轨的对应物 ★ window↔week（本周现算）、evaluations↔weekRecords（历史留档）。
  // 两套并排返回、各自为 null/空数组，前端就不必猜「没有数据」是哪种没有。
  const week = weekly ? await previewWeek(user.id, today) : null;
  const weekRecords = weekly ? await loadWeekRecords(user.id) : [];

  return NextResponse.json({
    config: ADMISSION_CONFIG,
    // ★ 业务日由服务端给 ★ 客户端算不出上海业务日，页面要靠它认出「今天这场」是哪一场
    today,
    gate: await examGate(user, today, track),
    attempts,
    attemptsTotal,
    page,
    recordsPerPage: RECORDS_PER_PAGE,
    todayExam: todayRow
      ? {
          state: todayRow.verdict === null ? ('running' as const) : ('done' as const),
          scored: todayScored,
          total: todayRow.sessionIds.length,
        }
      : { state: 'none' as const, scored: 0, total: ADMISSION_CONFIG.sessionsPerExam },
    sessionInfo,
    viewingAll,
    identity: {
      employeeType: user.employeeType,
      participationMode: user.participationMode,
      stage: user.stage,
      stageOverride: user.stageOverride,
      /** 他走哪条考试轨。状态屏所有的分叉都读它，不再自己拼身份判断 */
      track,
    },
    unlock: unlockState(drills.done, user.stage, drills.nonSimple),
    window,
    evaluations,
    weeklyConfig: WEEKLY_EXAM_CONFIG,
    week,
    weekRecords,
  });
}
