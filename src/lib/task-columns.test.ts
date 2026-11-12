/**
 * 6 个格子的符号规范（2026-08-24 王老师定：一形一义，一色一动作）。
 *
 * ★ 这份测试锁的不是像素，是「同一个符号不许有两个意思」★
 * 出事那次就是 `—` 同时表示「系统没评出分」（要找开发）和「那天他还没入职」
 * （谁都不用管），而且在前一天那三格里**颜色完全相同**——主管没有任何办法分辨。
 */

import { describe, expect, it } from 'vitest';
import { markOf, SCORE_MARK } from './task-columns';

const cell = (over: Partial<Parameters<typeof markOf>[0]> = {}) => ({
  missing: true,
  score: null,
  beforeHire: false,
  locked: false,
  ...over,
});

/** 把「主管要做的事」枚举成五种情形，各取一格 */
const CASES = {
  有分: markOf(cell({ missing: false, score: 68 }), false),
  没评出分: markOf(cell({ missing: false, score: null }), false),
  今天还没考到: markOf(cell(), true),
  入职前: markOf(cell({ beforeHire: true }), false),
  未解锁: markOf(cell({ locked: true }), false),
  缺考: markOf(cell(), false),
};

describe('格子符号规范', () => {
  it('★ 一形一义：一个符号不许对应两件要做的事 ★', () => {
    // 「今天还没考到」与「入职前」故意共用「·」——两者要做的事都是「什么都不用做」。
    // 除此之外，任意两种情形的符号都必须不同。
    expect(CASES.今天还没考到.mark).toBe('·');
    expect(CASES.入职前.mark).toBe('·');

    const distinct = [CASES.有分, CASES.没评出分, CASES.今天还没考到, CASES.未解锁, CASES.缺考].map((m) =>
      String(m.mark),
    );
    expect(new Set(distinct).size).toBe(distinct.length);
  });

  it('★「—」不许再出现 ★ 它就是当初撞车的那个符号', () => {
    for (const m of Object.values(CASES)) expect(m.mark).not.toBe('—');
  });

  it('★ 一色一动作 ★ 红＝催考试、橙＝催演习，各自独占', () => {
    expect(CASES.缺考.color).toBe('var(--bad)');
    expect(CASES.未解锁.color).toBe('var(--warn)');
    // 「不用管」的那几种都不许染成红或橙——那会让主管去催一个没做错事的人
    for (const m of [CASES.有分, CASES.没评出分, CASES.今天还没考到, CASES.入职前]) {
      expect(m.color).not.toBe('var(--bad)');
      expect(m.color).not.toBe('var(--warn)');
    }
  });

  it('「没评出分」要比「还轮不到他」显眼——它是要人去处理的', () => {
    expect(CASES.没评出分.mark).toBe('?');
    expect(CASES.没评出分.color).toBe('var(--muted)'); // 0.62，比 --faint(0.42) 深
    expect(CASES.今天还没考到.color).toBe('var(--faint)');
  });

  it('★ 今天还能补练 → 画「·」不画「锁」★ 现在就判未解锁是提前定性', () => {
    const todayStillOpen = markOf(cell({ locked: true }), true);
    expect(todayStillOpen.mark).toBe('·');
    // 同一格，等这一天过完就该变成「锁」
    expect(markOf(cell({ locked: true }), false).mark).toBe('锁');
  });

  it('入职前优先于缺考——那天他还不是员工，不能记他的账', () => {
    expect(markOf(cell({ beforeHire: true, locked: true }), false).mark).toBe('·');
  });

  it('有分的格子交出 SCORE_MARK，由渲染层去画那个数字', () => {
    expect(CASES.有分.mark).toBe(SCORE_MARK);
  });

  it('★ 每句悬停解释都要说清「该催谁」或「不是什么」★', () => {
    expect(CASES.缺考.why).toContain('考试');
    expect(CASES.未解锁.why).toContain('演习');
    expect(CASES.未解锁.why).toContain('不是缺考');
    expect(CASES.没评出分.why).toContain('开发');
    expect(CASES.入职前.why).toContain('不是缺考');
  });
});
