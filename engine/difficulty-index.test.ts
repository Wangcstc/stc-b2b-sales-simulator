/**
 * 机制难度指数的测试（2026-08-28 第三批）。
 *
 * ★ 这个指数最危险的用法是「拿它当档位标签」★
 * 全池实测已经证明它和标签量的不是同一个东西：声明「简单」的 18 份机制上最重
 * （中位 50），「标准」最轻（中位 34）。所以它的职责只有一条——**相对比较**：
 * 同一个考点派生两档时，验证两档真的拉开了。用例把这条边界钉住。
 */

import { describe, expect, it } from 'vitest';
import {
  bandOfLabel,
  mechanicalDifficulty,
  MIN_BAND_GAP,
  type MechanicalProbe,
} from './difficulty-index';

function probe(over: Partial<MechanicalProbe> = {}): MechanicalProbe {
  return {
    initialPatience: 100,
    finishedAt: 10,
    patienceLeft: 60,
    died: null,
    collectedElements: 6,
    cardCount: 4,
    maxRequireDepth: 0,
    dualGateCards: 0,
    distractorCount: 2,
    ...over,
  };
}

describe('mechanicalDifficulty：越难分越高', () => {
  it('打通得越晚越难', () => {
    const early = mechanicalDifficulty(probe({ finishedAt: 6 })).index;
    const late = mechanicalDifficulty(probe({ finishedAt: 18 })).index;
    expect(late).toBeGreaterThan(early);
  });

  it('耗掉的容错越多越难', () => {
    const cheap = mechanicalDifficulty(probe({ patienceLeft: 90 })).index;
    const dear = mechanicalDifficulty(probe({ patienceLeft: 10 })).index;
    expect(dear).toBeGreaterThan(cheap);
  });

  it('★ 打不通直接把「卡住」拉满 ★ 好新人按标准问法都干不完活，说明机制卡死了', () => {
    const ok = mechanicalDifficulty(probe({ finishedAt: 20 }));
    const stuck = mechanicalDifficulty(probe({ finishedAt: null }));
    expect(stuck.parts.blocked).toBe(100);
    expect(stuck.index).toBeGreaterThan(ok.index);
  });

  it('中途掉出去也算卡满', () => {
    expect(mechanicalDifficulty(probe({ died: 'patienceZero（第 7 轮）' })).parts.blocked).toBe(100);
  });

  it('结构越重越难：暗牌、依赖链、双组解锁、干扰项', () => {
    const light = mechanicalDifficulty(probe()).index;
    const heavy = mechanicalDifficulty(
      probe({ cardCount: 8, maxRequireDepth: 3, dualGateCards: 6, distractorCount: 5 }),
    ).index;
    expect(heavy).toBeGreaterThan(light);
    expect(mechanicalDifficulty(probe({ cardCount: 8, maxRequireDepth: 3, dualGateCards: 6, distractorCount: 5 })).parts.structure).toBe(100);
  });

  it('永远夹在 0–100，脏输入不会把总分带跑', () => {
    const wild = mechanicalDifficulty(
      probe({ initialPatience: 0, patienceLeft: -50, finishedAt: 999, cardCount: 99, distractorCount: 99 }),
    );
    expect(wild.index).toBeGreaterThanOrEqual(0);
    expect(wild.index).toBeLessThanOrEqual(100);
  });

  /**
   * ★ 一份「换汤不换药的困难版」必须落在门槛之内 ★
   * 只把 `difficulty` 字段从 standard 改成 hard、机制一个字没动的变体，
   * 它和兄弟的指数差应当远小于 MIN_BAND_GAP —— 那正是 autoplay 闸⑧ 要拦的东西。
   */
  it('机制没动的两份，指数差不到 MIN_BAND_GAP', () => {
    const base = mechanicalDifficulty(probe()).index;
    const fake = mechanicalDifficulty(probe({ distractorCount: 3 })).index;
    expect(Math.abs(fake - base)).toBeLessThan(MIN_BAND_GAP);
  });

  it('真把旋钮拧动了，指数差得开', () => {
    const base = mechanicalDifficulty(probe()).index;
    const real = mechanicalDifficulty(
      probe({ finishedAt: 18, patienceLeft: 15, cardCount: 8, maxRequireDepth: 3, dualGateCards: 6 }),
    ).index;
    expect(real - base).toBeGreaterThanOrEqual(MIN_BAND_GAP);
  });
});

describe('bandOfLabel：simple_with_distractors 也是简单档', () => {
  it('三档映射与 inquiry-pool.bucketOf 一致', () => {
    expect(bandOfLabel('hard')).toBe('hard');
    expect(bandOfLabel('standard')).toBe('standard');
    expect(bandOfLabel('simple_with_distractors')).toBe('simple');
    expect(bandOfLabel('simple')).toBe('simple');
  });
});
