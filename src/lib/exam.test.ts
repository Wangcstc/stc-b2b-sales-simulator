/**
 * 考试选题与共用小工具的测试。
 *
 * ★ 为什么 pickExamVariants 值得仔细测 ★
 * 它决定每个人考到哪三道题，而它自己的注释写着两条硬要求：
 * ① 三个槽位的难度必须受控——「困难局能不能撑住」正是准入要判的东西；
 * ② 必须随机——固定顺序等于可透题，先考完的人把三道题告诉后面的，
 *    「每人每日 1 次」这道闸门当场作废。
 * 这两条都是"错了不会报错、只会悄悄失效"的那种，所以只能靠测试盯着。
 *
 * 随机性用注入的 rand 来测：生产代码默认 Math.random，测试里给定序列，
 * 这样既能验"确实按 rand 取"，又不会让用例本身变成随机的。
 */

import { describe, expect, it } from 'vitest';
import {
  assertConclusionClean,
  examSlotOf,
  median,
  pickExamVariants,
  pickSlotVariant,
  type ExamCandidate,
} from './exam';

/** 造一道题。id 只用于断言时看得出是哪一道 */
function v(id: string, sessionType: 'INQUIRY' | 'FOLLOWUP', difficulty: string) {
  return { id, sessionType, difficulty } as ExamCandidate & { id: string };
}

/** 一个料齐的池子：标准探需 ×2、困难探需 ×2、跟进 ×2 */
function fullPool() {
  return [
    v('std1', 'INQUIRY', 'standard'),
    v('std2', 'INQUIRY', 'standard'),
    v('hard1', 'INQUIRY', 'hard'),
    v('hard2', 'INQUIRY', 'hard'),
    v('fup1', 'FOLLOWUP', 'standard'),
    v('fup2', 'FOLLOWUP', 'hard'),
  ];
}

/** 固定取每组的第一个，让"选中了哪一类"这件事可断言 */
const FIRST = () => 0;

describe('pickExamVariants：三局怎么选', () => {
  it('料齐时严格是「探需·标准 + 探需·困难 + 跟进」，不报缺料', () => {
    const { picked, shortfalls } = pickExamVariants(fullPool(), FIRST);
    expect(picked).toHaveLength(3);
    expect(picked[0]!.sessionType).toBe('INQUIRY');
    expect(picked[0]!.difficulty).toBe('standard');
    expect(picked[1]!.sessionType).toBe('INQUIRY');
    expect(picked[1]!.difficulty).toBe('hard');
    expect(picked[2]!.sessionType).toBe('FOLLOWUP');
    expect(shortfalls).toEqual([]);
  });

  it('★ 同一道题不会被选两次 ★', () => {
    // 池子里正好三道，各槽位只能各拿一道
    const pool = [v('a', 'INQUIRY', 'standard'), v('b', 'INQUIRY', 'hard'), v('c', 'FOLLOWUP', 'standard')];
    const { picked } = pickExamVariants(pool, FIRST);
    expect(new Set(picked)).toHaveLength(3);
  });

  it('★ 按注入的 rand 取，不是固定取第一个 ★ 这条保证的是"不可透题"', () => {
    const pool = fullPool();
    // rand 恒返回 0.99 → 每组取最后一个
    const { picked } = pickExamVariants(pool, () => 0.99);
    expect((picked[0] as { id: string }).id).toBe('std2');
    expect((picked[1] as { id: string }).id).toBe('hard2');
    expect((picked[2] as { id: string }).id).toBe('fup2');
  });

  it('不同的 rand 序列会选出不同的组合——否则"随机"是假的', () => {
    const pool = fullPool();
    const a = pickExamVariants(pool, FIRST).picked.map((p) => (p as { id: string }).id);
    const b = pickExamVariants(pool, () => 0.99).picked.map((p) => (p as { id: string }).id);
    expect(a).not.toEqual(b);
  });

  describe('缺料时降级，但必须说出来（"可以将就，不可以假装齐了"）', () => {
    it('没有标准探需局 → 用别的难度顶，并报缺', () => {
      const pool = [v('h1', 'INQUIRY', 'hard'), v('h2', 'INQUIRY', 'hard'), v('f', 'FOLLOWUP', 'standard')];
      const { picked, shortfalls } = pickExamVariants(pool, FIRST);
      expect(picked).toHaveLength(3);
      expect(shortfalls).toContain('池子里没有标准探需局，用别的难度顶了一局');
    });

    it('没有困难探需局 → 用标准顶，并报缺', () => {
      const pool = [v('s1', 'INQUIRY', 'standard'), v('s2', 'INQUIRY', 'standard'), v('f', 'FOLLOWUP', 'standard')];
      const { shortfalls } = pickExamVariants(pool, FIRST);
      expect(shortfalls).toContain('池子里没有困难探需局，用标准局顶了一局');
    });

    it('没有跟进局 → 用探需局顶，并报缺', () => {
      const pool = [
        v('s', 'INQUIRY', 'standard'),
        v('h', 'INQUIRY', 'hard'),
        v('s2', 'INQUIRY', 'standard'),
      ];
      const { picked, shortfalls } = pickExamVariants(pool, FIRST);
      expect(picked).toHaveLength(3);
      expect(shortfalls).toContain('池子里没有跟进局，用探需局顶了一局');
    });

    it('★ 空池子不抛错，三个槽位各报一条缺 ★ 考试接口要能把这话透给用户', () => {
      const { picked, shortfalls } = pickExamVariants([], FIRST);
      expect(picked).toEqual([]);
      expect(shortfalls).toHaveLength(3);
      expect(shortfalls.join()).toContain('探需局不足');
      expect(shortfalls.join()).toContain('跟进局这一局没凑上');
    });

    it('只有一道探需局 → 第一槽拿走，后两槽都凑不上', () => {
      const { picked, shortfalls } = pickExamVariants([v('only', 'INQUIRY', 'standard')], FIRST);
      expect(picked).toHaveLength(1);
      expect(shortfalls).toContain('探需局不足，困难难度这一局没凑上');
      expect(shortfalls).toContain('跟进局这一局没凑上');
    });
  });

  it('不修改传进来的池子', () => {
    const pool = fullPool();
    const snapshot = [...pool];
    pickExamVariants(pool, FIRST);
    expect(pool).toEqual(snapshot);
  });
});

describe('median：全站唯一一份中位数', () => {
  it('奇数个取中间那个', () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([5])).toBe(5);
  });

  it('偶数个取中间两个的平均', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([60, 70])).toBe(65);
  });

  it('★ 不依赖入参顺序 ★ 乱序、倒序结果都一样', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 3, 2, 1])).toBe(2.5);
  });

  it('不修改传进来的数组——它常常是别处还要用的那一份', () => {
    const nums = [3, 1, 2];
    median(nums);
    expect(nums).toEqual([3, 1, 2]);
  });

  it('★ 空数组返回 0，不是 NaN ★ 这是它和曾经那份重复实现的关键差别', () => {
    expect(median([])).toBe(0);
    expect(Number.isNaN(median([]))).toBe(false);
  });

  it('负数与小数照常', () => {
    expect(median([-3, -1, -2])).toBe(-2);
    expect(median([1.5, 2.5])).toBe(2);
  });
});

describe('assertConclusionClean：结论文案不许出现等级表述', () => {
  it('干净文案放行', () => {
    expect(() => assertConclusionClean('演习段位 D，局分 68')).not.toThrow();
    expect(() => assertConclusionClean('')).not.toThrow();
  });

  it('★ L1–L5 一律拦下 ★', () => {
    for (const bad of ['已达到 L2', '接近 L4 水平', 'L1 起步']) {
      expect(() => assertConclusionClean(bad), bad).toThrow(/禁用的等级表述/);
    }
  });

  it('「能力段位」「达到 L」也拦', () => {
    expect(() => assertConclusionClean('他的能力段位不低')).toThrow();
    expect(() => assertConclusionClean('达到 L 级')).toThrow();
  });

  it('★ 不误伤 ★ L 后面不是 1–5、或 L 嵌在单词里的，不该拦', () => {
    expect(() => assertConclusionClean('演习段位 D')).not.toThrow();
    expect(() => assertConclusionClean('L6 不在禁用范围')).not.toThrow();
    expect(() => assertConclusionClean('FCL 整柜、LCL 拼箱')).not.toThrow();
    expect(() => assertConclusionClean('型号 XL2 的产品')).not.toThrow();
  });
});

/**
 * ★ 这一组盯的是「随机的单位」★（2026-08-28）
 *
 * `pickSlotVariant` 改动之前是在**变体**里等概率随机。困难探需槽的真实分布是
 * P19×6 / P7×4 / P12×2 / P3×2，于是 43% 的考试都在考 P19——而防重复只排除
 * 「上一场用过的骨架」，隔一场它就能回来。**换了国家品类人名，要问的东西一个字没变。**
 *
 * 这类错误不会报错、不会有人察觉，只会让同一个考点反复出现，所以只能靠测试钉住。
 */
describe('pickSlotVariant：先在考点里等概率，再在变体里等概率', () => {
  /** 照困难探需槽的真实分布造：P19 六份、P7 四份、P12 两份、P3 两份 */
  function hardSlot() {
    const out: { id: string; personaCode: string }[] = [];
    const spread: [string, number][] = [['P19', 6], ['P7', 4], ['P12', 2], ['P3', 2]];
    for (const [code, n] of spread) {
      for (let i = 1; i <= n; i += 1) out.push({ id: `${code}-${i}`, personaCode: code });
    }
    return out;
  }

  it('★ 四个考点各 25%，不是按变体份数分 ★', () => {
    const pool = hardSlot();
    const hits = new Map<string, number>();
    // 第一次调用挑考点、第二次挑变体。这里把「挑考点」那一次扫过 [0,1)，
    // 「挑变体」固定取 0——于是统计出来的就是考点被选中的分布本身。
    const STEPS = 1000;
    for (let i = 0; i < STEPS; i += 1) {
      let call = 0;
      const rand = () => (call++ === 0 ? i / STEPS : 0);
      const picked = pickSlotVariant(pool, rand)!;
      hits.set(picked.personaCode, (hits.get(picked.personaCode) ?? 0) + 1);
    }
    // 四个考点必须各占四分之一。旧实现下 P19 会是 6/14 ≈ 43%
    expect([...hits.keys()].sort()).toEqual(['P12', 'P19', 'P3', 'P7']);
    for (const count of hits.values()) expect(count).toBe(STEPS / 4);
  });

  it('选中考点之后，在这个考点自己的变体里挑', () => {
    const pool = hardSlot();
    // 考点取排序后的第一个（P12），变体取它的第二份
    const seq = [0, 0.9];
    let i = 0;
    const picked = pickSlotVariant(pool, () => seq[i++]!)!;
    expect(picked.personaCode).toBe('P12');
    expect(picked.id).toBe('P12-2');
  });

  /**
   * ★ 键必须排序 ★ Map 的插入序取决于候选是怎么从库里查出来的。
   * 不排序的话，同一个 rand 序列在两种查询顺序下会抽到不同的题，测试锁不住任何东西。
   */
  it('候选顺序不影响结果', () => {
    const pool = hardSlot();
    const seq = () => {
      const s = [0.5, 0.1];
      let i = 0;
      return () => s[i++]!;
    };
    const a = pickSlotVariant(pool, seq())!;
    const b = pickSlotVariant([...pool].reverse(), seq())!;
    expect(a.personaCode).toBe(b.personaCode);
  });

  it('空候选返回 undefined，不抛', () => {
    expect(pickSlotVariant([])).toBeUndefined();
  });

  it('rand 取到 1 也不越界（Math.random 的上界是开区间，但别赌它）', () => {
    const pool = hardSlot();
    expect(pickSlotVariant(pool, () => 0.999999)).toBeDefined();
    expect(pickSlotVariant(pool, () => 1)).toBeDefined();
  });
});

describe('examSlotOf：分档口径全站只有这一份', () => {
  it('跟进局不看难度', () => {
    expect(examSlotOf({ sessionType: 'FOLLOWUP', difficulty: 'standard' })).toBe('FOLLOWUP');
    expect(examSlotOf({ sessionType: 'FOLLOWUP', difficulty: 'hard' })).toBe('FOLLOWUP');
  });

  it('探需按难度分两档', () => {
    expect(examSlotOf({ sessionType: 'INQUIRY', difficulty: 'standard' })).toBe('STANDARD_INQUIRY');
    expect(examSlotOf({ sessionType: 'INQUIRY', difficulty: 'hard' })).toBe('HARD_INQUIRY');
  });

  /** 简单探需不进考试池：考试要判的是「标准和困难撑不撑得住」 */
  it('简单探需不属于任何槽位', () => {
    expect(examSlotOf({ sessionType: 'INQUIRY', difficulty: 'simple_with_distractors' })).toBeNull();
  });
});
