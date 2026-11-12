import { describe, it, expect } from 'vitest';
import {
  WEEKLY_EXAM_CONFIG,
  judgeWeek,
  weekIsOver,
  weekStartOf,
  weekEndOf,
  weekRangeText,
  weekMedianLabel,
  weekStatusLine,
  type WeekSession,
} from './weekly-exam';
import { recentWeekStarts, weekdayOf } from './business-day';

/**
 * 正式业务员的周考规则（2026-08-24 王老师定）：
 * 「每周至少考两场，也就是每周至少有 6 局的考试分数出来。」
 *
 * ★ 这份测试锁的是三件事 ★
 * ① 自然周的边界（周日归上一周，不是下一周）——错一天，整周的账全错；
 * ② met 的三态（周中不下结论）——把 null 写成 false，等于周三就催人；
 * ③ 只认考试局、按天数场次——这两条是「练习不计分」和「每天 1 场」的落点。
 */

const s = (over: Partial<WeekSession> & { businessDay: string }): WeekSession => ({
  sessionId: `${over.businessDay}-${Math.random()}`,
  type: 'INQUIRY',
  precise: true,
  rawScore: 70,
  ...over,
});

/** 某天开 3 局，模拟一整场考试 */
const oneExam = (day: string, score = 70): WeekSession[] =>
  [1, 2, 3].map((n) => s({ businessDay: day, rawScore: score, sessionId: `${day}-${n}` }));

// 2026-08-24 是周一，08-30 是周日
const MON = '2026-08-24';
const TUE = '2026-08-25';
const WED = '2026-08-26';
const SUN = '2026-08-30';
const NEXT_MON = '2026-08-31';

describe('自然周边界', () => {
  it('周一到周日属于同一周，周一是周首', () => {
    for (const day of [MON, TUE, WED, '2026-08-27', '2026-08-28', '2026-08-29', SUN]) {
      expect(weekStartOf(day)).toBe(MON);
    }
    expect(weekEndOf(MON)).toBe(SUN);
  });

  it('★ 周日归上一周，不是下一周 ★ JS 的 getDay 把周日当 0，直接减会整整错一周', () => {
    expect(weekdayOf(SUN)).toBe(0);
    expect(weekStartOf(SUN)).toBe(MON);
    expect(weekStartOf(NEXT_MON)).toBe(NEXT_MON);
  });

  it('跨月、跨年都不出错', () => {
    // 2026-01-01 是周四 → 那一周从 2025-12-29（周一）起
    expect(weekStartOf('2026-01-01')).toBe('2025-12-29');
    expect(weekEndOf('2025-12-29')).toBe('2026-01-04');
    // 2026-09-01 是周二 → 周首落在 08-31
    expect(weekStartOf('2026-09-01')).toBe('2026-08-31');
  });

  it('recentWeekStarts 从新到旧、每周差 7 天', () => {
    const weeks = recentWeekStarts(3, WED);
    expect(weeks).toEqual([MON, '2026-08-17', '2026-08-10']);
  });

  it('weekIsOver：周日当天还没过完，下周一才算过完', () => {
    expect(weekIsOver(MON, SUN)).toBe(false);
    expect(weekIsOver(MON, NEXT_MON)).toBe(true);
  });
});

describe('场次与局数', () => {
  it('考满 2 场（6 局）→ 达标', () => {
    const v = judgeWeek([...oneExam(TUE), ...oneExam(MON)], MON, WED);
    expect(v.examCount).toBe(2);
    expect(v.preciseCount).toBe(WEEKLY_EXAM_CONFIG.sessionsPerWeek);
    expect(v.met).toBe(true);
    expect(v.examGap).toBe(0);
  });

  it('★ 场次按业务日去重，不按局数除以 3 ★ 同一天多出来的局不该变成第二场', () => {
    const v = judgeWeek([...oneExam(MON), s({ businessDay: MON })], MON, WED);
    expect(v.examCount).toBe(1);
    expect(v.examGap).toBe(1);
  });

  it('只考了 1 场、周还没过完 → met 是 null，不是 false', () => {
    const v = judgeWeek(oneExam(MON), MON, WED);
    expect(v.met).toBe(null);
    expect(v.detail).toContain('这周还要再考 1 场');
  });

  it('★ 周过完了才下结论 ★ 只考 1 场且已跨到下周一 → 未达标', () => {
    const v = judgeWeek(oneExam(MON), MON, NEXT_MON);
    expect(v.met).toBe(false);
    expect(v.detail).toContain('这一周已经过完');
  });

  it('一局没考、周已过完 → 未达标，差满 2 场', () => {
    const v = judgeWeek([], MON, NEXT_MON);
    expect(v.met).toBe(false);
    expect(v.examCount).toBe(0);
    expect(v.examGap).toBe(WEEKLY_EXAM_CONFIG.examsPerWeek);
    expect(v.medianScore).toBe(null);
  });

  it('别的周的局不许算进这一周', () => {
    const v = judgeWeek([...oneExam(NEXT_MON), ...oneExam('2026-08-23'), ...oneExam(MON)], MON, NEXT_MON);
    expect(v.examCount).toBe(1);
    expect(v.examDays).toEqual([MON]);
  });
});

describe('中位数与样本', () => {
  it('取精确分的中位数', () => {
    const v = judgeWeek([...oneExam(MON, 60), ...oneExam(TUE, 80)], MON, WED);
    expect(v.medianScore).toBe(70);
    expect(v.scoreOk).toBe(true);
  });

  it('★ 没出精确分的局不进中位数，但照样陈列 ★ 那不是他的错，不该被当成 0 分', () => {
    const v = judgeWeek(
      [...oneExam(MON, 80), ...[1, 2, 3].map((n) => s({ businessDay: TUE, precise: false, rawScore: null, sessionId: `t${n}` }))],
      MON,
      WED,
    );
    expect(v.sampleCount).toBe(6);
    expect(v.preciseCount).toBe(3);
    expect(v.medianScore).toBe(80);
    // 场次够了但出分局数不够 → 还不能算达标
    expect(v.met).toBe(null);
    expect(v.sessionGap).toBe(3);
  });

  it('★ 一局都没出分时中位数是 null，不许写 0 ★ 0 分和「还没考」是两回事', () => {
    const v = judgeWeek([], MON, WED);
    expect(v.medianScore).toBe(null);
    expect(v.scoreOk).toBe(null);
  });

  it('中位数低于参考线也不影响 met——周考只记录，不处罚', () => {
    const v = judgeWeek([...oneExam(MON, 30), ...oneExam(TUE, 30)], MON, NEXT_MON);
    expect(v.scoreOk).toBe(false);
    expect(v.met).toBe(true);
  });
});

describe('文案', () => {
  it('版头那一格必须带分母，样本不齐时更要带', () => {
    expect(weekMedianLabel(judgeWeek([], MON, WED))).toBe('— · 本周 0/6 局');
    expect(weekMedianLabel(judgeWeek([...oneExam(MON, 68), ...oneExam(TUE, 68)], MON, WED))).toBe(
      '68 分 · 本周 6/6 局',
    );
  });

  it('未达标必须带距离，不能只说「未达标」', () => {
    expect(judgeWeek([], MON, NEXT_MON).detail).toContain('还差 2 场');
  });

  it('周次文案是人话，不是 2026-08-24 那种硬日期', () => {
    expect(weekRangeText(MON)).toBe('8月24日 – 8月30日');
  });

  /**
   * ★ 「还差 0 场」这句话不许出现 ★
   * 两场都考了、但有一局证据不足没出分时，缺口在「出分」那一头，examGap 是 0。
   * 原来周中那一支只认 examGap，屏上就会写「进行中 · 还差 0 场」。
   */
  it('缺口在出分那一头时，单位要跟着换成「局出分」', () => {
    const twoExamsOneUnscored = [
      ...oneExam(MON, 70),
      ...oneExam(TUE, 70).map((x, i) => (i === 0 ? { ...x, precise: false, rawScore: null } : x)),
    ];
    const midWeek = judgeWeek(twoExamsOneUnscored, MON, WED);
    expect(midWeek.examGap).toBe(0);
    expect(midWeek.sessionGap).toBe(1);
    expect(weekStatusLine(midWeek)).toBe('进行中 · 还差 1 局出分');

    const closed = judgeWeek(twoExamsOneUnscored, MON, NEXT_MON);
    expect(weekStatusLine(closed)).toBe('未考满 · 差 1 局出分');

    expect(weekStatusLine(judgeWeek([...oneExam(MON), ...oneExam(TUE)], MON, WED))).toBe('本周已考满');
    expect(weekStatusLine(judgeWeek(oneExam(MON), MON, WED))).toBe('进行中 · 还差 1 场');
  });
});

describe('阈值锁', () => {
  it('★ 每周 2 场 = 6 局 ★ 改这两个数就是改王老师定的规则，改之前先回去看裁定', () => {
    expect(WEEKLY_EXAM_CONFIG.examsPerWeek).toBe(2);
    expect(WEEKLY_EXAM_CONFIG.sessionsPerExam).toBe(3);
    expect(WEEKLY_EXAM_CONFIG.sessionsPerWeek).toBe(
      WEEKLY_EXAM_CONFIG.examsPerWeek * WEEKLY_EXAM_CONFIG.sessionsPerExam,
    );
  });
});
