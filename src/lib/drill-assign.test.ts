/**
 * 演习派单内核的测试（2026-08-28 第四批）。
 *
 * ★ 这套逻辑的错法全是静默的 ★
 *   · 盒子退到底 → 人练了三周的进度被一次失手清零，他只会觉得白练了；
 *   · 没到期也判到期 → 间隔重复退化成"天天重复"，防背题当场失效；
 *   · 拿五力里的任何一力去筛考点 → 命中全部 32 个考点，等于随机派题还多写一层；
 *   · 样本不够就认定"最弱项" → 一次偶然失手被放大成一整周的训练方向。
 * 没有一种会抛异常，所以只能靠用例钉住。
 */

import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  intervalOf,
  leitnerNext,
  personaPriority,
  weakestForceOf,
  LEITNER_INTERVALS,
  MAX_BOX,
  PASS_SCORE,
  type MasteryState,
} from './drill-assign';

describe('Leitner 盒子', () => {
  it('打到准入线就进位', () => {
    expect(leitnerNext(1, PASS_SCORE)).toBe(2);
    expect(leitnerNext(3, 80)).toBe(4);
  });

  it('★ 没到线退一格，不是退到底 ★ 一次失手清零三周进度，人只会觉得白练了', () => {
    expect(leitnerNext(4, 50)).toBe(3);
    expect(leitnerNext(2, 64)).toBe(1);
  });

  it('第 1 盒失败就留在第 1 盒，不会退成 0', () => {
    expect(leitnerNext(1, 10)).toBe(1);
  });

  it('第 5 盒已经封顶，再过也不会有第 6 盒', () => {
    expect(leitnerNext(MAX_BOX, 90)).toBe(MAX_BOX);
  });

  it('★ 证据不足的局不动盒子 ★ 那不是学员的错，拿它退位就是冤枉人', () => {
    expect(leitnerNext(3, null)).toBe(3);
  });

  it('间隔按盒号取，越界夹回合法范围', () => {
    expect(intervalOf(1)).toBe(LEITNER_INTERVALS[0]);
    expect(intervalOf(5)).toBe(LEITNER_INTERVALS[4]);
    expect(intervalOf(0)).toBe(LEITNER_INTERVALS[0]);
    expect(intervalOf(99)).toBe(LEITNER_INTERVALS[4]);
  });

  it('daysBetween 是纯字符串算术，不读时钟', () => {
    expect(daysBetween('2026-08-01', '2026-08-08')).toBe(7);
    expect(daysBetween('2026-08-08', '2026-08-08')).toBe(0);
    expect(daysBetween('坏日期', '2026-08-08')).toBe(0);
  });
});

describe('personaPriority：三项加权', () => {
  const base = { activeForces: ['insight', 'guidance'], sessionType: 'inquiry' as const };
  const ctx = { today: '2026-08-28', weakestForce: null };

  function mastery(over: Partial<MasteryState> = {}): MasteryState {
    return { code: 'P9', box: 1, lastDay: '2026-08-27', lastScore: 70, plays: 1, ...over };
  }

  it('没练过的考点拿满新鲜分', () => {
    const p = personaPriority(base, ctx);
    expect(p.parts.fresh).toBe(1);
    expect(p.reason).toContain('还没练过');
  });

  it('上次分越低，弱项分越高', () => {
    const low = personaPriority({ ...base, mastery: mastery({ lastScore: 30 }) }, ctx).parts.weak;
    const high = personaPriority({ ...base, mastery: mastery({ lastScore: 60 }) }, ctx).parts.weak;
    expect(low).toBeGreaterThan(high);
  });

  it('已经过线的考点不算弱项', () => {
    expect(personaPriority({ ...base, mastery: mastery({ lastScore: 80 }) }, ctx).parts.weak).toBe(0);
  });

  it('★ 没到期就是 0，不是负数 ★ 负数会把总分拉花', () => {
    // 第 3 盒间隔 7 天，昨天刚练过
    const p = personaPriority({ ...base, mastery: mastery({ box: 3, lastDay: '2026-08-27' }) }, ctx);
    expect(p.parts.due).toBe(0);
  });

  it('到期当天开始算到期分，越拖越高但封顶 1', () => {
    const due = personaPriority({ ...base, mastery: mastery({ box: 1, lastDay: '2026-08-27' }) }, ctx);
    expect(due.parts.due).toBeGreaterThanOrEqual(1);
    const veryLate = personaPriority({ ...base, mastery: mastery({ box: 1, lastDay: '2026-01-01' }) }, ctx);
    expect(veryLate.parts.due).toBe(1);
    expect(due.reason).toContain('该复习了');
  });

  /**
   * ★ 这一条是这套设计里最要紧的一个边界 ★
   * 32 个考点全都主考 insight/guidance/solution/trust/closing，
   * 拿它们筛考点命中全部——所以这五力一律不给加成，否则"定向"就是假的。
   */
  it('★ 五个通用力不给「主考它」那份加成 ★ 它们 32 个考点全都主考，筛了等于没筛', () => {
    // 洞察力最弱 + 探需局 → 只拿得到局型偏好那 0.15，拿不到 forceFocus 的 0.5
    const inquiry = personaPriority(base, { ...ctx, weakestForce: 'insight' });
    expect(inquiry.parts.weak).toBeCloseTo(0.15, 5);
    // 换成跟进局 → 连局型偏好都没有，回到 0
    const followup = personaPriority({ ...base, sessionType: 'followup' }, { ...ctx, weakestForce: 'insight' });
    expect(followup.parts.weak).toBe(0);
    // 而 negotiation 这种能区分考点的，加成是 0.5 起，量级完全不同
    const focused = personaPriority(
      { activeForces: ['negotiation'], sessionType: 'followup' },
      { ...ctx, weakestForce: 'negotiation' },
    );
    expect(focused.parts.weak).toBeGreaterThanOrEqual(0.5);
  });

  /**
   * ★ 理由要按信息量排，不按计算顺序 ★
   * 第一版按计算顺序取第一条，于是一个「主考你最弱那一力」的考点，
   * 界面上显示的却是「这个考点还没练过」——把最有用的那句话盖掉了。
   */
  it('主考弱项力的理由，要盖过「还没练过」', () => {
    const p = personaPriority(
      { activeForces: ['negotiation'], sessionType: 'followup' },
      { ...ctx, weakestForce: 'negotiation' },
    );
    expect(p.parts.fresh).toBe(1); // 确实没练过
    expect(p.reason).toContain('博弈力'); // 但显示的是更有用的那句
  });

  it('博弈力最弱时，主考博弈力的考点拿加成', () => {
    const hit = personaPriority(
      { activeForces: ['negotiation', 'closing'], sessionType: 'followup' },
      { ...ctx, weakestForce: 'negotiation' },
    );
    const miss = personaPriority(
      { activeForces: ['insight', 'closing'], sessionType: 'followup' },
      { ...ctx, weakestForce: 'negotiation' },
    );
    expect(hit.parts.weak).toBeGreaterThan(miss.parts.weak);
    expect(hit.reason).toContain('博弈力');
  });

  it('稳定力同理', () => {
    const hit = personaPriority(
      { activeForces: ['stability'], sessionType: 'inquiry' },
      { ...ctx, weakestForce: 'stability' },
    );
    expect(hit.parts.weak).toBeGreaterThan(0);
    expect(hit.reason).toContain('稳定力');
  });

  it('总分永远在 0–1', () => {
    const wild = personaPriority(
      { activeForces: ['negotiation'], sessionType: 'followup', mastery: mastery({ lastScore: 0, box: 1, lastDay: '2020-01-01' }) },
      { today: '2026-08-28', weakestForce: 'negotiation' },
    );
    expect(wild.total).toBeGreaterThanOrEqual(0);
    expect(wild.total).toBeLessThanOrEqual(1);
  });
});

describe('weakestForceOf：样本不够就不猜', () => {
  const row = (insight: number, closing: number) => ({ insight, closing });

  it('局数不够返回 null', () => {
    expect(weakestForceOf([row(2, 4), row(2, 4)])).toBeNull();
  });

  it('够了就返回均分最低的那一力', () => {
    expect(weakestForceOf([row(2, 4), row(2, 5), row(1, 4)])).toBe('insight');
  });

  /** 只评过一两次的力不该永远当"最弱" */
  it('★ 单力样本不够也不算 ★ 否则"只评过一次的力"永远是最弱的', () => {
    const rows = [
      { insight: 3, closing: 3 },
      { insight: 3, closing: 3 },
      { insight: 3, closing: 3, negotiation: 1 },
    ];
    expect(weakestForceOf(rows)).not.toBe('negotiation');
  });
});
