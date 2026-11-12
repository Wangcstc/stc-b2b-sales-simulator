/**
 * 每晚结算判定内核的测试。
 *
 * ★ 为什么这个文件重要 ★
 * 这段逻辑决定一个实习业务员**停不停询盘分配**——是整套系统里后果最重的判定。
 * 在 2026-08-25 把它从 `evaluateUserDay()` 里拆出来之前，它一个测试都没有：
 * 不是没人想测，是它夹在四次查库和三次写库中间，根本没法测。
 *
 * 所以这里的用例覆盖的是「以前只能靠人肉推演」的那些边角：
 * 连续不达标的滚动、样本不足既不加也不清零、人工锁定只管当天、横幅在锁定期不发。
 */

import { describe, expect, it } from 'vitest';
import {
  bannerOf,
  decideDay,
  recommendStage,
  rollConsecutiveFails,
  type DayDecisionInput,
} from './settlement-decide';
import { ADMISSION_CONFIG, type WindowVerdict } from './admission-v11';
import type { WorkCalendar } from './business-day';

/** 全年无休的日历：把「生效日 = 下一个工作日」简化成「第二天」，好让断言只盯判定本身 */
const ALWAYS_WORK: WorkCalendar = { isWorkday: () => true };

function verdictOf(over: Partial<WindowVerdict> = {}): WindowVerdict {
  const gate = (key: 'score' | 'insight' | 'redline' | 'answer', passed: boolean) => ({
    key,
    label: key,
    passed,
    text: '',
  });
  return {
    sampleCount: 6,
    preciseCount: 6,
    enough: true,
    medianScore: 70,
    insightMedian: 70,
    answerMedian: 70,
    passed: true,
    gates: [],
    allGates: [gate('score', true), gate('insight', true), gate('redline', true), gate('answer', true)],
    effectiveRedlines: [],
    pendingRedlines: [],
    scoreGap: 0,
    sampleText: '',
    slots: [],
    missingByDay: [],
    ...over,
  } as WindowVerdict;
}

function inputOf(over: Partial<DayDecisionInput> = {}): DayDecisionInput {
  return {
    day: '2026-08-20',
    verdict: verdictOf(),
    stageBefore: 'TRAINING',
    stageOverride: false,
    stageSetAt: null,
    previousConsecutiveFails: 0,
    companyCalendar: ALWAYS_WORK,
    ...over,
  };
}

describe('rollConsecutiveFails：连续不达标怎么滚', () => {
  it('不达标累加', () => {
    expect(rollConsecutiveFails(false, 0)).toBe(1);
    expect(rollConsecutiveFails(false, 3)).toBe(4);
  });

  it('达标清零', () => {
    expect(rollConsecutiveFails(true, 5)).toBe(0);
  });

  it('★ 样本不足既不加也不清零 ★「没考够」不是「没考好」，两个方向都是冤枉人', () => {
    expect(rollConsecutiveFails(null, 0)).toBe(0);
    expect(rollConsecutiveFails(null, 1)).toBe(1);
    expect(rollConsecutiveFails(null, 7)).toBe(7);
  });
});

describe('recommendStage：系统推荐的期别', () => {
  it('达标就给在岗，不管之前在哪一期', () => {
    expect(recommendStage({ passed: true, consecutiveFails: 0, stageBefore: 'TRAINING' })).toBe('ACTIVE');
    expect(recommendStage({ passed: true, consecutiveFails: 0, stageBefore: 'ACTIVE' })).toBe('ACTIVE');
  });

  it('不达标但没到连续次数线，维持原状——一天没考好不该把人往下推', () => {
    expect(recommendStage({ passed: false, consecutiveFails: 1, stageBefore: 'ACTIVE' })).toBe('ACTIVE');
  });

  it(`连续不达标到 ${ADMISSION_CONFIG.consecutiveFailsToSuspend} 次才退回训练期`, () => {
    const n = ADMISSION_CONFIG.consecutiveFailsToSuspend;
    expect(recommendStage({ passed: false, consecutiveFails: n - 1, stageBefore: 'ACTIVE' })).toBe('ACTIVE');
    expect(recommendStage({ passed: false, consecutiveFails: n, stageBefore: 'ACTIVE' })).toBe('TRAINING');
  });

  it('★ 样本不足一律维持原状 ★ 哪怕连续次数已经很高——它不是"没考好"', () => {
    expect(recommendStage({ passed: null, consecutiveFails: 99, stageBefore: 'ACTIVE' })).toBe('ACTIVE');
    expect(recommendStage({ passed: null, consecutiveFails: 99, stageBefore: 'TRAINING' })).toBe('TRAINING');
  });
});

describe('bannerOf：横幅发哪一条', () => {
  const base = { consecutiveFails: 0, overrideActive: false };

  it('训练期 → 在岗：获得分配权', () => {
    expect(bannerOf({ ...base, stageBefore: 'TRAINING', applied: 'ACTIVE', passed: true })).toBe('GRANTED');
  });

  it('在岗 → 训练期：暂停', () => {
    expect(bannerOf({ ...base, stageBefore: 'ACTIVE', applied: 'TRAINING', passed: false, consecutiveFails: 2 })).toBe(
      'SUSPENDED',
    );
  });

  it('在岗且达标：保持', () => {
    expect(bannerOf({ ...base, stageBefore: 'ACTIVE', applied: 'ACTIVE', passed: true })).toBe('KEPT');
  });

  it('在岗、不达标但还没到停线：预警', () => {
    expect(bannerOf({ ...base, stageBefore: 'ACTIVE', applied: 'ACTIVE', passed: false, consecutiveFails: 1 })).toBe(
      'WARNED',
    );
  });

  it('★ 人工锁定期间一条都不发 ★ 预警写的是"明天起将暂停"，而他被锁着，明天不会暂停', () => {
    for (const kind of [
      { stageBefore: 'TRAINING' as const, applied: 'ACTIVE' as const, passed: true },
      { stageBefore: 'ACTIVE' as const, applied: 'TRAINING' as const, passed: false },
      { stageBefore: 'ACTIVE' as const, applied: 'ACTIVE' as const, passed: true },
    ]) {
      expect(bannerOf({ ...kind, consecutiveFails: 2, overrideActive: true })).toBeNull();
    }
  });

  it('训练期里继续不达标：不发横幅（他本来就在训练期，没有新消息）', () => {
    expect(
      bannerOf({ ...base, stageBefore: 'TRAINING', applied: 'TRAINING', passed: false, consecutiveFails: 3 }),
    ).toBeNull();
  });
});

describe('decideDay：整段判定', () => {
  it('达标 → 推荐在岗、连续次数清零、横幅 GRANTED', () => {
    const d = decideDay(inputOf({ previousConsecutiveFails: 2 }));
    expect(d.passed).toBe(true);
    expect(d.consecutiveFails).toBe(0);
    expect(d.recommendedStage).toBe('ACTIVE');
    expect(d.appliedStage).toBe('ACTIVE');
    expect(d.banner).toBe('GRANTED');
  });

  it('在岗连续第二天不达标 → 退回训练期并 SUSPENDED', () => {
    const d = decideDay(
      inputOf({
        verdict: verdictOf({ passed: false }),
        stageBefore: 'ACTIVE',
        previousConsecutiveFails: 1,
      }),
    );
    expect(d.consecutiveFails).toBe(2);
    expect(d.recommendedStage).toBe('TRAINING');
    expect(d.appliedStage).toBe('TRAINING');
    expect(d.banner).toBe('SUSPENDED');
  });

  describe('人工设定只管当天（2026-08-22 王老师定）', () => {
    it('结算的是设定日之前的日子 → 锁定仍生效，期别不动', () => {
      const d = decideDay(
        inputOf({
          day: '2026-08-19',
          verdict: verdictOf({ passed: false }),
          stageBefore: 'ACTIVE',
          previousConsecutiveFails: 1,
          stageOverride: true,
          stageSetAt: new Date('2026-08-20T02:00:00Z'),
        }),
      );
      expect(d.overrideActive).toBe(true);
      // 推荐照算照记，但不生效——这正是「照算照记，但不改 stage」
      expect(d.recommendedStage).toBe('TRAINING');
      expect(d.appliedStage).toBe('ACTIVE');
      expect(d.banner).toBeNull();
    });

    it('★ 结算设定日当天 → 锁定失效，系统接管 ★ 这是修掉"被永久锁住"那个坑的关键一条', () => {
      const d = decideDay(
        inputOf({
          day: '2026-08-20',
          verdict: verdictOf({ passed: false }),
          stageBefore: 'ACTIVE',
          previousConsecutiveFails: 1,
          stageOverride: true,
          stageSetAt: new Date('2026-08-20T02:00:00Z'),
        }),
      );
      expect(d.overrideActive).toBe(false);
      expect(d.appliedStage).toBe('TRAINING');
      expect(d.banner).toBe('SUSPENDED');
    });

    it('没设定过（stageOverride=false）时，stageSetAt 有值也不算锁定', () => {
      const d = decideDay(
        inputOf({ day: '2026-08-19', stageOverride: false, stageSetAt: new Date('2026-08-20T02:00:00Z') }),
      );
      expect(d.overrideActive).toBe(false);
    });
  });

  it('★ 四条 gate 按 key 取，不按下标 ★ 顺序打乱也要落到对的列上', () => {
    const g = (key: 'score' | 'insight' | 'redline' | 'answer', passed: boolean) => ({
      key,
      label: key,
      passed,
      text: '',
    });
    const d = decideDay(
      inputOf({
        // 故意打乱顺序，并让四条各不相同
        verdict: verdictOf({
          allGates: [g('answer', false), g('redline', true), g('score', false), g('insight', true)],
        }),
      }),
    );
    expect(d.scoreOk).toBe(false);
    expect(d.insightOk).toBe(true);
    expect(d.redlineOk).toBe(true);
    expect(d.answerOk).toBe(false);
  });

  it('allGates 里缺某一条时按未通过算，不抛错', () => {
    const d = decideDay(inputOf({ verdict: verdictOf({ allGates: [] }) }));
    expect(d.scoreOk).toBe(false);
    expect(d.answerOk).toBe(false);
  });

  it('★ sessionIds 只收窗口格子里真有的局 ★ 空格（缺考）不能混进判定依据', () => {
    const d = decideDay(
      inputOf({
        verdict: verdictOf({
          slots: [
            { session: { sessionId: 'a' } },
            { session: null },
            { session: { sessionId: 'b' } },
          ] as unknown as WindowVerdict['slots'],
        }),
      }),
    );
    expect(d.sessionIds).toEqual(['a', 'b']);
  });

  it('生效日取下一个工作日：周末连休时要跳过去', () => {
    // 只有 08-24（周一）是工作日，08-22/23 是周末
    const calendar: WorkCalendar = { isWorkday: (day: string) => day === '2026-08-24' };
    const d = decideDay(inputOf({ day: '2026-08-21', companyCalendar: calendar }));
    expect(d.effectiveDay).toBe('2026-08-24');
  });

  it('留档带上口径指纹——改了阈值没重算，ledger-audit 认得出来', () => {
    const d = decideDay(inputOf());
    expect(d.detail.ruleFingerprint).toContain('score>=');
  });

  it('★ 纯函数：同样输入永远同样输出 ★', () => {
    const input = inputOf({ verdict: verdictOf({ passed: false }), previousConsecutiveFails: 1 });
    expect(decideDay(input)).toEqual(decideDay(input));
  });
});
