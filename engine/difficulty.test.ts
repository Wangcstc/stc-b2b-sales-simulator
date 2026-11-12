/**
 * 难度系数 α 的单元测试。
 *
 * α 是主管在教练台上点一下就改全员打分的东西，算错一次全队的分数就错一天。
 * 所以这里把「方向」「不变量」「边界」逐条钉死。
 *
 * ★ 门槛永远是 65，不在这个文件的管辖范围内 ★
 * α 只折算局分，不碰门槛——那条纪律由 `admission-v11` 那边守着。
 */

import { describe, it, expect } from 'vitest';
import { DIFFICULTY_BOUNDS, normalizeFactor, applyDifficulty, rawNeededFor } from './difficulty';

describe('难度系数', () => {
  describe('normalizeFactor', () => {
    it('越界夹回区间', () => {
      expect(normalizeFactor(0.1)).toBe(DIFFICULTY_BOUNDS.min);
      expect(normalizeFactor(9)).toBe(DIFFICULTY_BOUNDS.max);
    });

    it('脏值一律退回 1.0——宁可按标准难度打分，也不能拿 NaN 去折算全队分数', () => {
      expect(normalizeFactor(undefined)).toBe(1);
      expect(normalizeFactor(null)).toBe(1);
      expect(normalizeFactor('abc')).toBe(1);
      expect(normalizeFactor(NaN)).toBe(1);
      expect(normalizeFactor(Infinity)).toBe(DIFFICULTY_BOUNDS.max);
    });

    it('只保留一位小数（0.8333 这种值没法跟人解释）', () => {
      expect(normalizeFactor(0.8333)).toBe(0.8);
      expect(normalizeFactor(1.26)).toBe(1.3);
    });
  });

  describe('applyDifficulty', () => {
    it('★α=1 一分不动★ 这是"1.0 就是现在的标准"这句承诺的兑现', () => {
      for (let raw = 0; raw <= 100; raw++) expect(applyDifficulty(raw, 1)).toBe(raw);
    });

    it('α>1 压低分数，α<1 抬高分数', () => {
      expect(applyDifficulty(70, 1.2)).toBe(65);
      expect(applyDifficulty(70, 0.8)).toBe(75);
      expect(applyDifficulty(60, 1.2)).toBe(54);
      expect(applyDifficulty(60, 0.8)).toBe(66);
    });

    it('★两端钉死★ 0 还是 0、100 还是 100，不会出现"满分只能拿 83"', () => {
      for (const f of [0.6, 0.8, 1, 1.2, 1.5]) {
        expect(applyDifficulty(0, f)).toBe(0);
        expect(applyDifficulty(100, f)).toBe(100);
      }
    });

    it('★严格单调★ 表现更好分数一定不更低，不许出现反转', () => {
      for (const f of [0.6, 0.9, 1.2, 1.5]) {
        let prev = -1;
        for (let raw = 0; raw <= 100; raw++) {
          const got = applyDifficulty(raw, f);
          expect(got).toBeGreaterThanOrEqual(prev);
          prev = got;
        }
      }
    });

    it('系数越大分数越低（同一个原始分横着比）', () => {
      const at = (f: number) => applyDifficulty(70, f);
      let prev = 101;
      for (let f = DIFFICULTY_BOUNDS.min; f <= DIFFICULTY_BOUNDS.max + 1e-9; f += 0.1) {
        const cur = at(Math.round(f * 10) / 10);
        expect(cur).toBeLessThanOrEqual(prev);
        prev = cur;
      }
    });

    it('分数永远夹在 0–100，脏输入也不例外', () => {
      for (const f of [0.6, 1, 1.5]) {
        expect(applyDifficulty(-20, f)).toBe(0);
        expect(applyDifficulty(180, f)).toBe(100);
      }
    });
  });

  describe('rawNeededFor —— 界面上真正该摆的那个数', () => {
    it('「系数 1.2 = 要打出 70 的水平才拿得到 65」', () => {
      expect(rawNeededFor(65, 1.2)).toBe(70);
      expect(rawNeededFor(65, 1.0)).toBe(65);
      expect(rawNeededFor(65, 0.8)).toBe(58);
    });

    it('和 applyDifficulty 互为反函数（允许 1 分取整误差）', () => {
      for (const f of [0.6, 0.8, 1, 1.2, 1.5]) {
        for (const target of [40, 50, 65, 80, 90]) {
          const need = rawNeededFor(target, f);
          expect(Math.abs(applyDifficulty(need, f) - target)).toBeLessThanOrEqual(1);
        }
      }
    });

    it('系数越大，要拿到 65 需要的原始水平越高', () => {
      let prev = -1;
      for (let f = DIFFICULTY_BOUNDS.min; f <= DIFFICULTY_BOUNDS.max + 1e-9; f += 0.1) {
        const cur = rawNeededFor(65, Math.round(f * 10) / 10);
        expect(cur).toBeGreaterThanOrEqual(prev);
        prev = cur;
      }
    });
  });
});
