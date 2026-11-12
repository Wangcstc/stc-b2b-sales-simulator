import { prisma } from './db';
import { businessDay } from './business-day';
import { settleExam } from './redline-review';

/**
 * 跨天没考完的考试怎么收场。
 *
 * ★ 2026-08-28 从 api/exam/route.ts 里抽出来 ★
 *
 * 规则本身早就写好了（「跨天没结算的场次不许把今天堵死」），落地却只落了一半：
 * 那段代码长在 `determineAttempt()` 里，而 `determineAttempt()` 只有
 * **POST /api/exam** 会走——也就是只有当事人亲手点了「开始今天的考试」才触发。
 *
 * 于是三件事同时成立，昨天那场就永远停在「进行中」：
 *   ① 每晚的结算（api/settlement）压根不看 ExamAttempt，只算局和分；
 *   ② 考试闸门的 GET 明写着「只读，不做清理」；
 *   ③ 考试记录列表按「这一局有没有分」画按钮，不看这场是哪天的——
 *      于是昨天那三局今天照样能点「继续/评分」「开始这一局」。
 * 结果就是王老师 2026-08-28 看到的：08-27 那场「进行中 · 0/3 局已出分」，
 * 而今天的考试也照样能开——一个人一天能打六局考试局。
 *
 * ★ 现在这个函数是「跨天作废」的唯一实现，三个地方都调它 ★
 *   · 每晚 00:05 的结算 —— 主路径，全员扫一遍（王老师要的「凌晨结算后复 0」）
 *     时刻的真源是 vercel.json 的 cron，界面文案取 SETTLE_LOCAL_TIME，两处一起改
 *   · GET /api/exam    —— 打开考试闸门就地补一次，不用干等到半夜
 *   · POST /api/exam   —— 开考前最后一道，保证并发下也不会漏
 *
 * ★ 能结算的先结算，结算不掉的才作废 ★ 三局都出了分只是没人点交卷，
 * 那不叫跨天作废，那叫忘了交卷——照常给他记成 SETTLED。
 */

/** 作废时写进 conclusion 的话。★ 只有这一处 ★ 改文案不要在调用点各写各的 */
export const EXPIRED_CONCLUSION =
  '这场考试跨天了，已作废，不计入你的考试次数。已经打完并出分的局照常进统计窗口，一局都不浪费。';

export interface ExpireResult {
  /** 扫到几场跨天未结的 */
  scanned: number;
  /** 其中补交卷成功的（三局分都齐，只是没人点交卷） */
  settled: number;
  /** 其中判作废的（有局没打完或没出分） */
  expired: number;
  /** 处理失败的，留给调用方决定是报警还是忽略 */
  failed: Array<{ attemptId: string; userId: string; businessDay: string | null; error: string }>;
}

/**
 * 把「业务日早于 today」且还没结算的每日考试收干净。
 *
 * ★ 幂等 ★ 处理过的场次 verdict 不再是 null，第二次扫就不在结果集里了。
 * 所以每晚跑、每次开页面跑、开考前再跑一次，都只会做一次事。
 *
 * @param userId 只收某一个人的。不给就是全员（每晚结算走这条）
 * @param today  business day 口径的今天。不给就现取——测试里要能定住
 */
export async function expireStaleAttempts(
  { userId, today = businessDay() }: { userId?: string; today?: string } = {},
): Promise<ExpireResult> {
  const stale = await prisma.examAttempt.findMany({
    where: {
      /**
       * ★ 必须锁死 DAILY ★ settleExam 见到非 DAILY 会**抛异常**（那是刻意的，
       * 见 redline-review.ts 那段注释）。库里的 LEGACY 老记录 businessDay 是 null，
       * `lt` 本来就筛不到它们，但口径要写在 where 里，不能靠"碰巧筛不到"。
       */
      attemptType: 'DAILY',
      verdict: null,
      businessDay: { lt: today },
      ...(userId ? { userId } : {}),
    },
    select: { id: true, userId: true, businessDay: true },
    // 从旧到新处理：万一一个人攒了好几天，日志读起来是按时间顺的
    orderBy: { businessDay: 'asc' },
  });

  const result: ExpireResult = { scanned: stale.length, settled: 0, expired: 0, failed: [] };

  for (const attempt of stale) {
    try {
      // 三局都有分 → 补一次交卷，当成正常场次收掉，不作废
      const verdict = await settleExam(attempt.id);
      if (verdict) {
        result.settled += 1;
        continue;
      }
      await prisma.examAttempt.update({
        where: { id: attempt.id },
        data: { verdict: 'EXPIRED', conclusion: EXPIRED_CONCLUSION },
      });
      result.expired += 1;
    } catch (error) {
      /**
       * ★ 一场炸掉不许带走整趟结算 ★ 这个函数挂在每晚那趟结算 cron 上，
       * 抛出去会让**后面所有人的判定**一起不跑——那是拿一个人的坏数据
       * 换全员少判一天，代价完全不成比例。记下来，继续扫。
       */
      result.failed.push({
        attemptId: attempt.id,
        userId: attempt.userId,
        businessDay: attempt.businessDay,
        error: (error as Error).message,
      });
    }
  }

  return result;
}
