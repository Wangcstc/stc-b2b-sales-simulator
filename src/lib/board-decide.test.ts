import { describe, it, expect } from 'vitest';
import {
  baseTaskDoneOf,
  baseTaskTextOf,
  cellOf,
  dayInProgressOf,
  lockedDaysOf,
  type BaseTaskInput,
  type DayGate,
  type WindowCell,
} from './board-decide';
import { ADMISSION_CONFIG, type WindowSlot } from './admission-v11';

/** 一格「有局且出了分」 */
function scored(day: string, rawScore: number, sameDay = true): WindowSlot {
  return {
    day,
    sameDay,
    nth: 1,
    session: { rawScore, precise: true } as unknown as WindowSlot['session'],
  };
}

/** 一格「有局但没评出精确分」 */
function imprecise(day: string, sameDay = true): WindowSlot {
  return {
    day,
    sameDay,
    nth: 1,
    session: { rawScore: 70, precise: false } as unknown as WindowSlot['session'],
  };
}

/** 一格「根本没有局」 */
function empty(day: string, sameDay = true): WindowSlot {
  return { day, sameDay, nth: 1, session: null };
}

const OPEN: DayGate = { done: 3, required: 3, unlocked: true };
const SHUT: DayGate = { done: 1, required: 3, unlocked: false };

const HIRED = '2026-08-10';

describe('cellOf —— 四种空格必须分得开', () => {
  it('有分的格子：score 是分数，其余标记全 false', () => {
    const cell = cellOf(scored('2026-08-20', 72), OPEN, HIRED);
    expect(cell).toMatchObject({ score: 72, missing: false, locked: false, beforeHire: false });
  });

  it('有局但证据不足：score 为 null，但 missing 必须是 false', () => {
    // ★ 这两种都画不出分数，但主管要找的人不一样 ★
    // missing = 去催他考；证据不足 = 去查为什么没评出来
    const cell = cellOf(imprecise('2026-08-20'), OPEN, HIRED);
    expect(cell.score).toBeNull();
    expect(cell.missing).toBe(false);
  });

  it('真缺考：解锁了却没有局', () => {
    const cell = cellOf(empty('2026-08-20'), OPEN, HIRED);
    expect(cell).toMatchObject({ missing: true, locked: false, beforeHire: false });
  });

  it('未解锁不是缺考：那天他压根考不了', () => {
    const cell = cellOf(empty('2026-08-20'), SHUT, HIRED);
    expect(cell.missing).toBe(true);
    expect(cell.locked).toBe(true);
  });

  it('入职前不是缺考：起判日当天也算在他进来之前', () => {
    // 2026-08-22 的老漏洞 E：新人第一天打开教练台看到三个红叉。
    // 起判日「当天及之前」都不算，用 <= 不是 <
    expect(cellOf(empty('2026-08-09'), OPEN, HIRED).beforeHire).toBe(true);
    expect(cellOf(empty(HIRED), OPEN, HIRED).beforeHire).toBe(true);
    expect(cellOf(empty('2026-08-11'), OPEN, HIRED).beforeHire).toBe(false);
  });

  it('拿不到那天的闸门数据，宁可按缺考显示，不敢说未解锁', () => {
    // 凭没有的证据替人开脱，会把真缺考的人也洗白
    const cell = cellOf(empty('2026-08-20'), undefined, HIRED);
    expect(cell.missing).toBe(true);
    expect(cell.locked).toBe(false);
  });

  it('有局的日子永远不会被标成未解锁或入职前', () => {
    // 他都考了，说他那天没解锁 / 还没入职，是自相矛盾
    const cell = cellOf(scored('2026-08-09', 80), SHUT, HIRED);
    expect(cell.locked).toBe(false);
    expect(cell.beforeHire).toBe(false);
  });

  it('sameDay 原样带过来——界面靠它分亮暗', () => {
    expect(cellOf(scored('2026-08-20', 70, false), OPEN, HIRED).sameDay).toBe(false);
  });
});

describe('dayInProgressOf —— 今天的空格不是缺考', () => {
  it('就是今天、还没考完 = 进行中', () => {
    expect(dayInProgressOf('2026-08-28', '2026-08-28', '未考')).toBe(true);
    expect(dayInProgressOf('2026-08-28', '2026-08-28', '进行中')).toBe(true);
  });

  it('今天已经考完了就不再是进行中', () => {
    expect(dayInProgressOf('2026-08-28', '2026-08-28', '已考')).toBe(false);
  });

  it('周六打开教练台：第一行是周五，而周五已经过完了', () => {
    // liveDay 传 null 表示「此刻不是任何一个业务日」。
    // 这时第一行那些空格是真缺考，不是「还没考到」
    expect(dayInProgressOf('2026-08-28', null, '未考')).toBe(false);
  });

  it('过去的日子一律不是进行中', () => {
    expect(dayInProgressOf('2026-08-20', '2026-08-28', '未考')).toBe(false);
  });
});

describe('lockedDaysOf', () => {
  const gates: Record<string, DayGate> = {
    '2026-08-20': { done: 1, required: 3, unlocked: false },
    '2026-08-21': { done: 2, required: 3, unlocked: false },
    '2026-08-28': { done: 0, required: 3, unlocked: false },
  };
  const gateOf = (day: string) => gates[day];

  function cells(...list: Array<Partial<WindowCell> & { day: string }>): WindowCell[] {
    return list.map((item) => ({
      score: null,
      sameDay: false,
      missing: true,
      beforeHire: false,
      locked: true,
      ...item,
    }));
  }

  it('列出未解锁的日子，带上那天差多少', () => {
    const out = lockedDaysOf(cells({ day: '2026-08-20' }), gateOf, false);
    expect(out).toEqual([{ day: '2026-08-20', done: 1, required: 3 }]);
  });

  it('同一天的三格只出现一次', () => {
    const out = lockedDaysOf(
      cells({ day: '2026-08-20' }, { day: '2026-08-20' }, { day: '2026-08-20' }),
      gateOf,
      false,
    );
    expect(out).toHaveLength(1);
  });

  it('新的排前面', () => {
    const out = lockedDaysOf(cells({ day: '2026-08-20' }, { day: '2026-08-21' }), gateOf, false);
    expect(out.map((item) => item.day)).toEqual(['2026-08-21', '2026-08-20']);
  });

  it('★ 今天还能补练，就不算今天未解锁 ★', () => {
    // 2026-08-24 的矛盾：格子那边画「·」说「今天还没考到」，
    // 「差在哪」这边却说「今天考试没解锁」——同一行两句话对着干
    const today = cells({ day: '2026-08-28', sameDay: true });
    expect(lockedDaysOf(today, gateOf, true)).toEqual([]);
    // 这一天过完之后（dayInProgress = false），它就该出现了
    expect(lockedDaysOf(today, gateOf, false)).toHaveLength(1);
  });

  it('前一个业务日不受 dayInProgress 影响', () => {
    // sameDay=false 的格子属于昨天，昨天已经过完，补不了了
    const out = lockedDaysOf(cells({ day: '2026-08-20', sameDay: false }), gateOf, true);
    expect(out).toHaveLength(1);
  });

  it('入职前的空格不算未解锁', () => {
    const out = lockedDaysOf(cells({ day: '2026-08-20', beforeHire: true }), gateOf, false);
    expect(out).toEqual([]);
  });

  it('没被标 locked 的格子不进来', () => {
    const out = lockedDaysOf(cells({ day: '2026-08-20', locked: false }), gateOf, false);
    expect(out).toEqual([]);
  });

  it('闸门数据缺了就跳过，不编一个 0/0 出来', () => {
    const out = lockedDaysOf(cells({ day: '2026-07-01' }), gateOf, false);
    expect(out).toEqual([]);
  });
});

describe('baseTaskDoneOf / baseTaskTextOf', () => {
  const base: BaseTaskInput = { training: true, required: 3, done: 3, examState: '已考', scoredToday: 3 };

  it('演习够了 + 考了 = 完成', () => {
    expect(baseTaskDoneOf(base)).toBe(true);
    expect(baseTaskTextOf(base)).toBe('完成');
  });

  it('在岗期不要求演习，考了就完成', () => {
    const row = { ...base, training: false, required: 0, done: 0 };
    expect(baseTaskDoneOf(row)).toBe(true);
    expect(baseTaskTextOf(row)).toBe('完成');
  });

  it('★ 演习不够时先说演习，不说「未考」★', () => {
    // 训练期演习不够，考试根本开不了。这时候写「未考」是在催一件他做不到的事
    const row = { ...base, done: 1, examState: '未考' as const, scoredToday: 0 };
    expect(baseTaskTextOf(row)).toBe('演习差 2 局');
    expect(baseTaskDoneOf(row)).toBe(false);
  });

  it('演习够了、考试打了一半：说还差几局', () => {
    const row = { ...base, examState: '进行中' as const, scoredToday: 1 };
    expect(baseTaskTextOf(row)).toBe(`考试差 ${ADMISSION_CONFIG.sessionsPerExam - 1} 局`);
  });

  it('进行中但一局都没出分，也至少说差 1 局，不说差 3 局以外的怪数', () => {
    const row = { ...base, examState: '进行中' as const, scoredToday: ADMISSION_CONFIG.sessionsPerExam };
    // 出分数 ≥ 应考数却还判进行中（跨天出分之类）时，Math.max 兜住不出现「差 0 局」
    expect(baseTaskTextOf(row)).toBe('考试差 1 局');
  });

  it('★ 过去那天开了考没打完，不能写「考试差 N 局」★', () => {
    // 那一天已经过完，那几局永远补不上。写「差 N 局」是催他去打完一件补不了的事
    const row = { ...base, examState: '已作废' as const, scoredToday: 2 };
    expect(baseTaskTextOf(row)).toBe('那天只打了 2 局就没了');
  });

  it('在岗期没考：直接「未考」，不提演习', () => {
    const row = { ...base, training: false, required: 0, done: 0, examState: '未考' as const, scoredToday: 0 };
    expect(baseTaskTextOf(row)).toBe('未考');
  });

  it('演习够了但没考 = 没完成', () => {
    const row = { ...base, examState: '未考' as const, scoredToday: 0 };
    expect(baseTaskDoneOf(row)).toBe(false);
    expect(baseTaskTextOf(row)).toBe('未考');
  });
});
