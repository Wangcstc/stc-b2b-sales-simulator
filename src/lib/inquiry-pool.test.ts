import { describe, expect, it } from 'vitest';
import {
  bucketOf,
  groupByPersona,
  personaCodeOrder,
  personaCoverage,
  pickRandom,
  pickTodayQueue,
  playLabel,
  type PlayRecord,
  type PoolItemShape,
} from './inquiry-pool';

/** 造池子：`P1:simple:2` = 骨架 P1、简单档、2 封 */
function pool(...specs: string[]): PoolItemShape[] {
  const items: PoolItemShape[] = [];
  for (const spec of specs) {
    const [code, difficulty, count] = spec.split(':') as [string, string, string];
    for (let i = 1; i <= Number(count); i += 1) {
      items.push({
        id: `${code}-${i}`,
        variantId: `${code}-XX-${String(i).padStart(3, '0')}`,
        persona: {
          code,
          name: `${code} 型`,
          tests: `${code} 考什么`,
          difficulty,
          sessionType: difficulty === 'hard' ? 'FOLLOWUP' : 'INQUIRY',
        },
      });
    }
  }
  return items;
}

function history(entries: Record<string, Partial<PlayRecord>>): Map<string, PlayRecord> {
  const map = new Map<string, PlayRecord>();
  for (const [id, rec] of Object.entries(entries)) {
    map.set(id, { count: 1, lastAt: null, bestScore: null, bestTier: null, ...rec });
  }
  return map;
}

const FULL = pool('P1:simple:3', 'P13:simple:3', 'P4:standard:2', 'P16:standard:2', 'P12:hard:2', 'P18:hard:2');

describe('难度分档', () => {
  it('simple_with_distractors 归进简单档', () => {
    expect(bucketOf('simple_with_distractors')).toBe('simple');
    expect(bucketOf('simple')).toBe('simple');
    expect(bucketOf('standard')).toBe('standard');
    expect(bucketOf('hard')).toBe('hard');
  });

  it('认不出来的难度兜底进简单档，不抛错', () => {
    expect(bucketOf('whatever')).toBe('simple');
  });
});

describe('P 编号自然序', () => {
  it('P2 排在 P10 前面（字符串排序会反过来）', () => {
    const codes = ['P10', 'P2', 'P32', 'P4'];
    expect([...codes].sort()).toEqual(['P10', 'P2', 'P32', 'P4']);
    expect([...codes].sort((a, b) => personaCodeOrder(a) - personaCodeOrder(b))).toEqual(['P2', 'P4', 'P10', 'P32']);
  });
});

describe('每日派单 pickTodayQueue', () => {
  it('简单／标准／困难各出一封', () => {
    const picked = pickTodayQueue(FULL, new Map(), new Set(), 'u|2026-08-23|0');
    expect(picked).toHaveLength(3);
    expect(picked.map((v) => bucketOf(v.persona.difficulty))).toEqual(['simple', 'standard', 'hard']);
  });

  it('今天已经开过的封不再出现——这就是「练完自动补一封」', () => {
    const seed = 'u|2026-08-23|0';
    const first = pickTodayQueue(FULL, new Map(), new Set(), seed);
    const opened = new Set([first[0]!.id]);
    const second = pickTodayQueue(FULL, new Map(), opened, seed);

    expect(second).toHaveLength(3);
    expect(second.map((v) => v.id)).not.toContain(first[0]!.id);
    // 被换掉的只有那一封，另外两封纹丝不动
    expect(second[1]!.id).toBe(first[1]!.id);
    expect(second[2]!.id).toBe(first[2]!.id);
  });

  it('没碰过的考点优先于碰过的', () => {
    const seed = 'u|2026-08-23|0';
    // 把 P1 练到 5 局，简单档就该轮到 P13
    const played = history({ 'P1-1': { count: 5, lastAt: new Date('2026-08-22T10:00:00Z') } });
    const picked = pickTodayQueue(FULL, played, new Set(), seed);
    expect(picked[0]!.persona.code).toBe('P13');
  });

  it('同一考点内，没练过的那一封优先', () => {
    const seed = 'u|2026-08-23|0';
    // 只留 P1 一个简单考点，其中 P1-1 已练过 → 该发 P1-2 或 P1-3
    const onlyP1 = pool('P1:simple:3', 'P4:standard:1', 'P12:hard:1');
    const played = history({ 'P1-1': { count: 2, lastAt: new Date('2026-08-22T10:00:00Z') } });
    const picked = pickTodayQueue(onlyP1, played, new Set(), seed);
    expect(picked[0]!.id).not.toBe('P1-1');
  });

  it('同一个人同一天结果稳定，换 nonce 才会变', () => {
    const a = pickTodayQueue(FULL, new Map(), new Set(), 'u|2026-08-23|0');
    const b = pickTodayQueue(FULL, new Map(), new Set(), 'u|2026-08-23|0');
    expect(b.map((v) => v.id)).toEqual(a.map((v) => v.id));

    // 「换一批」= 换 nonce。至少要换掉一封，否则这个按钮等于没有
    const rerolled = pickTodayQueue(FULL, new Map(), new Set(), 'u|2026-08-23|1');
    expect(rerolled.map((v) => v.id)).not.toEqual(a.map((v) => v.id));
  });

  it('不同的人拿到的不是同一批', () => {
    const a = pickTodayQueue(FULL, new Map(), new Set(), 'alice|2026-08-23|0');
    const b = pickTodayQueue(FULL, new Map(), new Set(), 'bob|2026-08-23|0');
    expect(b.map((v) => v.id)).not.toEqual(a.map((v) => v.id));
  });

  it('某一档的封全练过也不枯竭，退化成「最久没练的」轮转', () => {
    const seed = 'u|2026-08-23|0';
    const played = history({
      'P1-1': { count: 1, lastAt: new Date('2026-08-20T10:00:00Z') },
      'P1-2': { count: 1, lastAt: new Date('2026-08-21T10:00:00Z') },
      'P1-3': { count: 1, lastAt: new Date('2026-08-22T10:00:00Z') },
      'P13-1': { count: 1, lastAt: new Date('2026-08-22T11:00:00Z') },
      'P13-2': { count: 1, lastAt: new Date('2026-08-22T12:00:00Z') },
      'P13-3': { count: 1, lastAt: new Date('2026-08-22T13:00:00Z') },
    });
    const picked = pickTodayQueue(FULL, played, new Set(), seed);
    expect(picked).toHaveLength(3);
    // 最久没练的考点是 P1（8/20 那一局），且要发它下面最久没练的 P1-1
    expect(picked[0]!.id).toBe('P1-1');
  });

  it('某一档整档缺料时只跳过那一档，不抛错', () => {
    const noHard = pool('P1:simple:1', 'P4:standard:1');
    const picked = pickTodayQueue(noHard, new Map(), new Set(), 'u|2026-08-23|0');
    expect(picked.map((v) => bucketOf(v.persona.difficulty))).toEqual(['simple', 'standard']);
  });

  it('空池子返回空数组', () => {
    expect(pickTodayQueue([], new Map(), new Set(), 'u|2026-08-23|0')).toEqual([]);
  });

  it('三封互不重复', () => {
    const picked = pickTodayQueue(FULL, new Map(), new Set(), 'u|2026-08-23|0');
    expect(new Set(picked.map((v) => v.id)).size).toBe(picked.length);
  });
});

describe('按考点分组 groupByPersona', () => {
  it('一个考点一组，组内按 variantId 排', () => {
    const groups = groupByPersona(FULL, new Map());
    expect(groups).toHaveLength(6);
    const p1 = groups.find((g) => g.code === 'P1')!;
    expect(p1.variants.map((v) => v.variantId)).toEqual(['P1-XX-001', 'P1-XX-002', 'P1-XX-003']);
  });

  it('没碰过的考点排在碰过的前面', () => {
    const played = history({ 'P1-1': { count: 2 } });
    const groups = groupByPersona(FULL, played);
    expect(groups[groups.length - 1]!.code).toBe('P1');
    expect(groups.find((g) => g.code === 'P1')!.playedVariants).toBe(1);
    expect(groups.find((g) => g.code === 'P1')!.playedSessions).toBe(2);
  });

  it('同为没碰过时，按难度档再按 P 编号自然序', () => {
    const groups = groupByPersona(pool('P13:simple:1', 'P2:standard:1', 'P10:standard:1', 'P1:simple:1'), new Map());
    expect(groups.map((g) => g.code)).toEqual(['P1', 'P13', 'P2', 'P10']);
  });
});

describe('考点覆盖率', () => {
  it('数的是碰过的考点数，不是局数', () => {
    const played = history({ 'P1-1': { count: 5 }, 'P1-2': { count: 3 } });
    expect(personaCoverage(FULL, played)).toEqual({ touched: 1, total: 6 });
  });

  it('一局没练就是 0', () => {
    expect(personaCoverage(FULL, new Map())).toEqual({ touched: 0, total: 6 });
  });
});

describe('我的记录文案', () => {
  it('没记录就说没练过；有段位才带段位', () => {
    expect(playLabel(undefined)).toBe('没练过');
    expect(playLabel({ count: 1, lastAt: null, bestScore: null, bestTier: null })).toBe('练过 1 局');
    expect(playLabel({ count: 3, lastAt: null, bestScore: 62, bestTier: 'D3' })).toBe('练过 3 局 · 最好 D3');
  });
});

describe('随机一封', () => {
  it('rand 可注入，取得到首尾两端', () => {
    const list = [1, 2, 3, 4];
    expect(pickRandom(list, () => 0)).toBe(1);
    expect(pickRandom(list, () => 0.999)).toBe(4);
    expect(pickRandom([], () => 0)).toBeUndefined();
  });
});
