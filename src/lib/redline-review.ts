/**
 * 红线留痕 + 每日考试的本场小结（需求 8.3）
 *
 * ★ 这一层不做任何判定 ★
 * 可靠性分级在 engine/rules.ts 的 REDLINE_RELIABILITY 里：
 * R1/R4 纯代码判定直接生效；R2/R3 靠模型判，只作反馈，不否决任何人。
 *
 * ★ 「复核队列」已经名不副实（2026-08-24）★
 * 这个文件原来的主业是「排队等主管裁定，裁定之前考试结论一直悬着」。
 * 两件事先后把它掏空了：
 *   · 2026-08-21 红线退出准入判定 → 裁不裁都不影响谁能接询盘，面板从教练台下架
 *   · 2026-08-24 王老师裁定彻底取消人工裁定 → 接口与组件（/api/redline-review、
 *     RedlineReviewPanel）一并删除，从此**没有任何入口能写 CONFIRMED/DISMISSED**
 *
 * 现在这里只剩两件事：
 *   ① `enqueueRedlineReviews` —— **留痕**。把 R2/R3 连同触发轮次与原话写进 RedlineReview 表。
 *      没有人会去处理它，留着是为了将来能回答「模型这个月判了多少条 R3、准不准」——
 *      不留痕就永远查不了，而这正是取消人工裁定之后唯一还能校准模型的线索。
 *   ② `settleDailyAttempt` —— 当日 3 局的数字小结，落库给面板用。
 *
 * ★ 「过没过」不在这个文件里，也不在任何一场考试里 ★
 * 期别与询盘分配权由 `settlement.ts` 的每晚结算按最近 6 局算
 * （规则见 `admission-v11.judgeWindow`）。考试只出本场小结。
 */

import { prisma } from './db';
import type { ScoreOutput, SessionFacts } from '../../engine/types';
import { isHardRedline } from '../../engine/rules';
import { median, assertConclusionClean } from './exam';
import { ADMISSION_CONFIG } from './admission-v11';
import { examTrackOf } from './exam-track';
import { WEEKLY_EXAM_CONFIG } from './weekly-exam';

/**
 * 历史裁定。★ 2026-08-24 起不再产生新的 ★ 写入口已经删了，
 * 库里剩下的 3 条是取消之前主管判过的，重算那几天时照旧认。
 */
export type RedlineRuling = 'CONFIRMED' | 'DISMISSED';

export interface RedlineEvidence {
  /** 触发在第几轮 */
  turn: number | null;
  /** 那一轮新人的原话。要回头查模型判得准不准，看这一句就够，不必翻完整局 */
  quote: string | null;
  drillId: string;
  personaName: string;
}

/**
 * 把一局里模型判出来的红线（R2/R3）连同证据写进留痕表。幂等——同一局同一条只写一次。
 *
 * ★ 为什么在结算时写而不是触发时写 ★
 * 触发点散在主循环和报价接口两处，而且一局没打完时的红线可能被后续动作洗掉。
 * 结算时读最终的事实表，一次写清，两处调用点都不用改。
 *
 * ★ 名字留着没改 ★ 函数名里的 "Reviews" 是历史，现在它只留痕、不排队。
 * 改名要动三个调用点和表名，收益只是好看一点——留一句注释更划算。
 */
export async function enqueueRedlineReviews(
  sessionId: string,
  attemptId: string,
  redlines: string[],
): Promise<void> {
  const needReview = redlines.filter((r) => !isHardRedline(r));
  if (needReview.length === 0) return;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { variant: { include: { persona: true } }, messages: { orderBy: { turn: 'asc' } } },
  });
  if (!session) return;

  for (const redline of needReview) {
    /**
     * 找触发那一轮。
     *
     * ★ 消息里存的是抽取结果，不存红线代号 ★ 红线是引擎拿抽取信号算出来的，
     * 只汇总在事实表上。所以这里要反过来按信号找：
     *   R3 空催 ← is_empty_chase
     *   R2 疑罪从有 ← low_investment_on_suspicion
     * 找不到就留空：主管照样能点进对话看，给不出证据比给错证据强。
     */
    const signalOf: Record<string, (e: Record<string, unknown>) => boolean> = {
      R2: (e) => e.low_investment_on_suspicion === true,
      R3: (e) => e.is_empty_chase === true,
    };
    const match = signalOf[redline];
    const hit = match
      ? [...session.messages].reverse().find((m) => {
          const ext = m.extraction as Record<string, unknown> | null;
          return ext ? match(ext) : false;
        })
      : undefined;

    const evidence: RedlineEvidence = {
      turn: hit?.turn ?? null,
      quote: hit?.role === 'trainee' ? hit.content.slice(0, 400) : null,
      drillId: session.drillId,
      personaName: session.variant.persona.name,
    };

    await prisma.redlineReview.upsert({
      where: { sessionId_redline: { sessionId, redline } },
      // 已经排过队就只补考试 id，绝不覆盖 status——
      // 重复结算不能把主管已经做出的裁定抹回 PENDING
      update: { attemptId },
      create: { sessionId, attemptId, redline, evidence: evidence as unknown as object },
    });
  }
}

/** 读某场考试所有红线裁定，按 sessionId 归拢 */
export async function loadRulings(
  sessionIds: string[],
): Promise<Record<string, Partial<Record<string, RedlineRuling>>>> {
  const reviews = await prisma.redlineReview.findMany({ where: { sessionId: { in: sessionIds } } });
  const out: Record<string, Partial<Record<string, RedlineRuling>>> = {};
  for (const r of reviews) {
    if (r.status !== 'CONFIRMED' && r.status !== 'DISMISSED') continue;
    (out[r.sessionId] ??= {})[r.redline] = r.status;
  }
  return out;
}

/**
 * 重算一场考试的本场小结并落库。开考自动交卷与主管裁定之后都走这里，
 * 两条路径共用同一段代码——否则迟早算出两个不一样的结果。
 *
 * @returns 本场小结；考试不存在或有局没评分则返回 null
 */
export async function settleExam(attemptId: string) {
  const attempt = await prisma.examAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt) return null;

  /**
   * ★ 只剩一条路 ★（2026-08-24）
   *
   * 这里原来分三岔：`DAILY` → 本场小结；`LEGACY` → v2.0 的 `judgeExam`（门槛 45）；
   * 其余 → v3.0 双组五闸门。后两条从 v1.1 起就只服务历史记录，而库里一条都没有。
   * 三套判定并存的代价是两个同名常量（`EXAM_CONFIG.medianScoreMin=45` 与
   * `ADMISSION_CONFIG.medianScoreMin=65`），改错哪个都不报错。两条一起删了。
   *
   * ★ 这里宁可炸也不静默 ★ 库里出现非 DAILY 的考试，只可能是有人绕过 `api/exam`
   * 建了记录，或者 `attemptType` 吃到了 schema 的 `@default(LEGACY)`。
   * 那种记录没有任何判定路径能处理它——返回 null 会让它看起来"结算过了"，
   * 而它的三局分数其实照样进不了任何结论。
   */
  if (attempt.attemptType !== 'DAILY') {
    throw new Error(
      `考试 ${attemptId} 的 attemptType 是 ${attempt.attemptType}，不是 DAILY。` +
        'v1.1 起系统只创建 DAILY 考试，v2.0/v3.0 的判定路径已于 2026-08-24 删除。' +
        '这条记录不是本系统建的，请人工核对后再决定怎么处理。',
    );
  }
  // v1.1：每日考试只做「本场三局的小结」，**不在这里决定任何人的期别**。
  // 期别由 lib/settlement.ts 的每晚结算按最近 6 局算——判定和考试解耦，
  // 所以「不点结算」不再能把判定冻住。
  return settleDailyAttempt(attempt);
}

type AttemptRecord = NonNullable<Awaited<ReturnType<typeof prisma.examAttempt.findUnique>>>;

/**
 * v1.1 每日考试（3 局）的本场小结。
 *
 * ★ 它不判「通过／不通过」★ 方案第一节：判定用的是最近 6 局，不是今天这一场。
 * 所以这里只把当日三局的数字落库，给面板的「当日 3 局中位数」那一列用，
 * 顺便把 R2/R3 写进留痕表。verdict 只有两个值：null（还在考）/ SETTLED（已交卷）。
 */
async function settleDailyAttempt(attempt: AttemptRecord) {
  /**
   * ★ 先核对局数 ★（2026-08-28 加）
   *
   * 原来只有下面那道守卫：「登记了几局就得找到几局，且每局都有分」。
   * 它漏掉了一件事——**没检查登记的局数对不对**。于是一场只登记了 2 局的考试
   * 完美满足那道守卫（2 找到 2、两局都有分），会被当成一场完整的考试收掉，
   * 结论文案照写「今日 3 局已交卷」，而中位数其实是两局算出来的。
   *
   * 库里 2026-08-21 小许那条就是这个样子（seed-demo 的「考到一半」原来只建 2 局，
   * 那个 bug 同日已修）。真实的 POST /api/exam 永远建 3 局，所以生产路径撞不到；
   * 但守卫的意义就是在"撞不到"变成"撞到了"的那天拦一下。
   *
   * ★ 返回 null，不抛 ★ 上面那个 attemptType 的检查抛异常，是因为那种记录
   * 「没有任何判定路径能处理它」。这里不一样：局数不对是**可以有下一步**的——
   * 调用方拿到 null 会把它判成 EXPIRED（见 lib/exam-expiry.ts），
   * 那正是一场残缺考试该有的下场。抛出去只会让整趟结算停在这一条上。
   */
  if (attempt.sessionIds.length !== ADMISSION_CONFIG.sessionsPerExam) {
    console.error(
      `[settle] 考试 ${attempt.id} 登记了 ${attempt.sessionIds.length} 局，` +
        `而一场考试固定 ${ADMISSION_CONFIG.sessionsPerExam} 局——不给它交卷，当残局处理。`,
    );
    return null;
  }

  const sessions = await prisma.session.findMany({
    where: { id: { in: attempt.sessionIds } },
    include: { score: true },
  });
  if (sessions.length !== attempt.sessionIds.length || sessions.some((session) => !session.score)) return null;

  const ordered = attempt.sessionIds
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session): session is (typeof sessions)[number] => Boolean(session));

  for (const session of ordered) {
    const facts = session.facts as unknown as SessionFacts;
    await enqueueRedlineReviews(session.id, attempt.id, facts.redlines ?? []);
  }
  const rulings = await loadRulings(ordered.map((session) => session.id));

  const scores = ordered.flatMap((session) => (session.score!.rawScore === null ? [] : [session.score!.rawScore]));
  const insights = ordered.flatMap((session) => {
    const forces = (session.score!.forces ?? {}) as ScoreOutput;
    const insight = forces.insight?.score;
    return typeof insight === 'number' ? [insight] : [];
  });
  const answers = ordered.flatMap((session) =>
    session.score!.answerQuality === null ? [] : [session.score!.answerQuality],
  );

  const effective: string[] = [];
  const pending: string[] = [];
  ordered.forEach((session, index) => {
    const facts = session.facts as unknown as SessionFacts;
    for (const code of facts.redlines ?? []) {
      const ruling = rulings[session.id]?.[code];
      /**
       * ★ 用 isHardRedline，不要写死 'R1' ★（2026-08-24 修）
       * 这里原来是 `code === 'R1' || ruling === 'CONFIRMED'`，而 2026-08-23 加的
       * **R4「用中文作答」同样是 hard**（纯代码查汉字，没有解释空间）。
       * 结果 R4 掉进了 pending 那一档，被说成「待主管复核」——
       * 一条 100% 确定的事实，却挂着一个等人来判的标签，而且没有人会来判。
       * 可靠性分级的真源只有 REDLINE_RELIABILITY 一处，这里读它就不会再走偏。
       */
      if (isHardRedline(code) || ruling === 'CONFIRMED') effective.push(`第 ${index + 1} 局 ${code}`);
      else if (ruling !== 'DISMISSED') pending.push(`第 ${index + 1} 局 ${code}`);
    }
  });

  const dayMedian = scores.length > 0 ? median(scores) : 0;

  /**
   * ★ 尾巴那句话要跟着他走哪条轨说 ★（2026-08-24）
   * 原来写死「准入判定用的是最近 6 局，明天生效……连着两天不行才会动资格」，
   * 对正式业务员是**假的**：他根本没有资格可动。
   * 一句不适用的规则摆在结论里，比不说更糟——他会照着它安排自己的节奏。
   */
  const owner = await prisma.user.findUnique({
    where: { id: attempt.userId },
    select: { employeeType: true, participationMode: true },
  });
  const trackTail =
    owner && examTrackOf(owner) === 'WEEKLY'
      ? `★ 今天这一场不单独定生死 ★ 你的要求是每周至少 ${WEEKLY_EXAM_CONFIG.examsPerWeek} 场（${WEEKLY_EXAM_CONFIG.sessionsPerWeek} 局出分），` +
        '这一场只是进本周的记录。周考不影响询盘分配，也不影响任何权限。'
      : '★ 今天这一场不单独定生死 ★ 准入判定用的是最近 6 局，今晚结算，明天生效。' +
        '一天发挥失常拉不垮，连着两天不行才会动资格。';

  const conclusion =
    `今日 3 局已交卷：局分中位数 ${dayMedian}` +
    (effective.length > 0 ? `；本场生效红线 ${effective.join('、')}` : '') +
    (pending.length > 0 ? `；另有 ${pending.length} 条红线由模型判定（仅作反馈，不影响资格）` : '') +
    `。

` +
    trackTail;
  assertConclusionClean(conclusion);

  await prisma.examAttempt.update({
    where: { id: attempt.id },
    data: {
      medianScore: Math.round(dayMedian),
      minInsight: insights.length > 0 ? Math.min(...insights) : null,
      anyRedline: effective.length > 0 || pending.length > 0,
      medianAnswerQuality: answers.length > 0 ? Math.round(median(answers)) : null,
      validSessionCount: ordered.filter((session) => session.score!.precise).length,
      passed: null,
      verdict: 'SETTLED',
      conclusion,
    },
  });

  return { outcome: 'SETTLED' as const, dayMedian, effectiveRedlines: effective, pendingRedlines: pending, conclusion };
}
