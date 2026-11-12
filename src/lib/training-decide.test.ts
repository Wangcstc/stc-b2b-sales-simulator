/**
 * 结构化训练任务判定内核的测试。
 *
 * ★ 这两段判定的后果 ★
 * ① isValidTrainingSession —— 判"不算"就会把任务标 INVALID 并**再排一道补测**，
 *    也就是让新人今天重练一局。判宽了有人蒙混过关，判严了有人白练一局。
 * ② rankTrainingCandidates —— 决定他抽到哪道题。「同一天不重复」这条一旦失效，
 *    任务是完成了，可他练的是同一道题，什么也没练到，而且**没有任何报错**。
 */

import { describe, expect, it } from 'vitest';
import {
  BASELINE_TRAINING_PLAN,
  buildTrainingPlan,
  DEBRIEF_MIN_QUESTIONS,
  isDebriefComplete,
  isValidTrainingSession,
  MIN_TRAINEE_ACTIONS,
  rankTrainingCandidates,
  slotPersonaFilter,
  slotVariantFilter,
  trainingCycleId,
  type TaskSessionSnapshot,
} from './training-decide';

// ───────────────────────── 夹具 ─────────────────────────

/** 一份答得完整的复盘：5 题全答、无追问、无跳过 */
function goodQa(n = DEBRIEF_MIN_QUESTIONS): TaskSessionSnapshot['coachQa'] {
  return Array.from({ length: n }, () => ({
    answer: '我当时应该先问数量',
    followUp: null,
    followUpAnswer: null,
    skipped: false,
  }));
}

function sessionOf(over: Partial<TaskSessionSnapshot> = {}): TaskSessionSnapshot {
  return {
    status: 'ENDED',
    exitReason: null,
    messages: Array.from({ length: MIN_TRAINEE_ACTIONS }, () => ({ role: 'trainee' })),
    coachQa: goodQa(),
    score: { reportMd: '# 报告' },
    ...over,
  };
}

// ───────────────────────── 训练计划 ─────────────────────────

describe('buildTrainingPlan：一个周期 8 道题', () => {
  it('题量与顺序照抄基线计划', () => {
    const plan = buildTrainingPlan();
    expect(plan).toHaveLength(8);
    expect(plan.map((p) => p.slotType)).toEqual(BASELINE_TRAINING_PLAN.map((p) => p.slotType));
  });

  it('难度是递增的：简单 ×2 → 标准 ×3 → 困难 ×2 → 跟进 ×1', () => {
    expect(buildTrainingPlan().map((p) => p.slotType)).toEqual([
      'SIMPLE_INQUIRY',
      'SIMPLE_INQUIRY',
      'STANDARD_INQUIRY',
      'STANDARD_INQUIRY',
      'STANDARD_INQUIRY',
      'HARD_INQUIRY',
      'HARD_INQUIRY',
      'FOLLOWUP',
    ]);
  });

  it('★ 只解锁第一道，其余排队 ★ 一次全解锁，新人会挑简单的先做，难度梯度就白设计了', () => {
    const plan = buildTrainingPlan();
    expect(plan[0]!.status).toBe('UNLOCKED');
    expect(plan.slice(1).every((p) => p.status === 'PENDING')).toBe(true);
  });

  it('orderNo 从 1 连续排到 8', () => {
    expect(buildTrainingPlan().map((p) => p.orderNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('★ 只有最后一道困难局要背调包 ★ 背调是加料，不是每道题都配得起', () => {
    const withBg = buildTrainingPlan().filter((p) => p.requiresBg);
    expect(withBg).toHaveLength(1);
    expect(withBg[0]!.slotType).toBe('HARD_INQUIRY');
    expect(withBg[0]!.orderNo).toBe(7);
  });
});

describe('trainingCycleId：同一个人同一天必须得到同一个编号', () => {
  it('格式是 A-简码-起始日（去掉横杠）', () => {
    expect(trainingCycleId('AB', '2026-08-25')).toBe('A-AB-20260825');
  });

  it('同样输入永远同样输出——否则重复调用会生成两套任务', () => {
    expect(trainingCycleId('CD', '2026-08-01')).toBe(trainingCycleId('CD', '2026-08-01'));
  });

  it('不同人 / 不同起始日互不相同', () => {
    expect(trainingCycleId('AB', '2026-08-25')).not.toBe(trainingCycleId('CD', '2026-08-25'));
    expect(trainingCycleId('AB', '2026-08-25')).not.toBe(trainingCycleId('AB', '2026-08-26'));
  });
});

// ───────────────────────── 有效练习局 ─────────────────────────

describe('isDebriefComplete：复盘答完整了没', () => {
  it(`答满 ${DEBRIEF_MIN_QUESTIONS} 题且都有内容 → 完整`, () => {
    expect(isDebriefComplete(goodQa())).toBe(true);
  });

  it('少一题就不算完整', () => {
    expect(isDebriefComplete(goodQa(DEBRIEF_MIN_QUESTIONS - 1))).toBe(false);
  });

  it('★ 空字符串和纯空格都不算答了 ★ 否则敲个空格就能过', () => {
    for (const answer of ['', '   ', null]) {
      const qa = goodQa();
      qa[2] = { ...qa[2]!, answer };
      expect(isDebriefComplete(qa), `answer=${JSON.stringify(answer)}`).toBe(false);
    }
  });

  it('有追问却没答追问 → 不完整', () => {
    const qa = goodQa();
    qa[1] = { ...qa[1]!, followUp: '那你下一局打算怎么问？', followUpAnswer: null };
    expect(isDebriefComplete(qa)).toBe(false);
  });

  it('有追问且答了 → 完整', () => {
    const qa = goodQa();
    qa[1] = { ...qa[1]!, followUp: '那你下一局打算怎么问？', followUpAnswer: '先问数量再报价' };
    expect(isDebriefComplete(qa)).toBe(true);
  });

  it('★ 任何一题被跳过就不完整 ★ 哪怕它有答案', () => {
    const qa = goodQa();
    qa[4] = { ...qa[4]!, skipped: true };
    expect(isDebriefComplete(qa)).toBe(false);
  });

  it('一题都没有 → 不完整', () => {
    expect(isDebriefComplete([])).toBe(false);
  });
});

describe('isValidTrainingSession：这一局算不算「有效练习局」', () => {
  it('四条全中 → 有效', () => {
    expect(isValidTrainingSession(sessionOf())).toBe(true);
  });

  it('局还没结束 → 无效', () => {
    expect(isValidTrainingSession(sessionOf({ status: 'ACTIVE' }))).toBe(false);
  });

  it('★ 没出报告 → 无效 ★ 有 score 但 reportMd 为空也不算', () => {
    expect(isValidTrainingSession(sessionOf({ score: null }))).toBe(false);
    expect(isValidTrainingSession(sessionOf({ score: { reportMd: null } }))).toBe(false);
    expect(isValidTrainingSession(sessionOf({ score: { reportMd: '' } }))).toBe(false);
  });

  it('复盘没答完 → 无效', () => {
    expect(isValidTrainingSession(sessionOf({ coachQa: goodQa(2) }))).toBe(false);
  });

  it(`业务员动作不足 ${MIN_TRAINEE_ACTIONS} 次且没有离场 → 无效`, () => {
    const few = Array.from({ length: MIN_TRAINEE_ACTIONS - 1 }, () => ({ role: 'trainee' }));
    expect(isValidTrainingSession(sessionOf({ messages: few, exitReason: null }))).toBe(false);
  });

  it('★ 提前离场可以豁免动作数 ★ 客户被气走了本来就没机会说满，那一局照样有教育意义', () => {
    const few = Array.from({ length: 2 }, () => ({ role: 'trainee' }));
    expect(isValidTrainingSession(sessionOf({ messages: few, exitReason: 'patienceZero' }))).toBe(true);
  });

  it('★ 只数业务员的消息 ★ 客户和系统的消息再多也不顶用', () => {
    const messages = [
      ...Array.from({ length: 20 }, () => ({ role: 'customer' })),
      ...Array.from({ length: 2 }, () => ({ role: 'trainee' })),
    ];
    expect(isValidTrainingSession(sessionOf({ messages, exitReason: null }))).toBe(false);
  });

  it('正好等于门槛 → 有效（>= 不是 >）', () => {
    const exact = Array.from({ length: MIN_TRAINEE_ACTIONS }, () => ({ role: 'trainee' }));
    expect(isValidTrainingSession(sessionOf({ messages: exact }))).toBe(true);
  });
});

// ───────────────────────── 选题 ─────────────────────────

describe('rankTrainingCandidates：该派哪道题', () => {
  const c = (id: string, variantId: string) => ({ id, variantId });
  const pool = [c('i1', 'P1-GB-003'), c('i2', 'P2-US-001'), c('i3', 'P3-GH-001')];

  it('★ 优先给练得最少的 ★', () => {
    const useCount = new Map([
      ['i1', 5],
      ['i2', 0],
      ['i3', 2],
    ]);
    const ranked = rankTrainingCandidates({ candidates: pool, usedTodayIds: [], useCount });
    expect(ranked.map((r) => r.id)).toEqual(['i2', 'i3', 'i1']);
  });

  it('★ 今天练过的整个剔掉，不是排到后面 ★ 重复练同一道题，任务完成了却什么也没练到', () => {
    const useCount = new Map([['i2', 0]]);
    const ranked = rankTrainingCandidates({ candidates: pool, usedTodayIds: ['i2'], useCount });
    expect(ranked.map((r) => r.id)).not.toContain('i2');
    expect(ranked).toHaveLength(2);
  });

  it('★ 次数相同时按 variantId 排，结果稳定 ★ 否则刷新一下就换一道题', () => {
    const useCount = new Map<string, number>();
    const a = rankTrainingCandidates({ candidates: pool, usedTodayIds: [], useCount });
    const b = rankTrainingCandidates({ candidates: [...pool].reverse(), usedTodayIds: [], useCount });
    expect(a.map((r) => r.variantId)).toEqual(b.map((r) => r.variantId));
    expect(a[0]!.variantId).toBe('P1-GB-003');
  });

  it('没在 useCount 里的当作练过 0 次', () => {
    const useCount = new Map([['i1', 3]]);
    const ranked = rankTrainingCandidates({ candidates: pool, usedTodayIds: [], useCount });
    expect(ranked[ranked.length - 1]!.id).toBe('i1');
  });

  it('★ 今天全练过 → 返回空数组 ★ 调用方据此报错，不要硬派一道重复的', () => {
    const ranked = rankTrainingCandidates({
      candidates: pool,
      usedTodayIds: ['i1', 'i2', 'i3'],
      useCount: new Map(),
    });
    expect(ranked).toEqual([]);
  });

  it('空候选池 → 空数组，不抛错', () => {
    expect(rankTrainingCandidates({ candidates: [], usedTodayIds: [], useCount: new Map() })).toEqual([]);
  });

  it('不修改传进来的候选数组', () => {
    const candidates = [...pool];
    const snapshot = [...candidates];
    rankTrainingCandidates({ candidates, usedTodayIds: [], useCount: new Map() });
    expect(candidates).toEqual(snapshot);
  });
});

describe('slotPersonaFilter：槽位 → 人设筛选条件', () => {
  it('跟进槽只要跟进局，不限难度', () => {
    expect(slotPersonaFilter('FOLLOWUP')).toEqual({ sessionType: 'FOLLOWUP' });
  });

  it('困难 / 标准槽各自锁死难度', () => {
    expect(slotPersonaFilter('HARD_INQUIRY')).toEqual({ sessionType: 'INQUIRY', difficulty: 'hard' });
    expect(slotPersonaFilter('STANDARD_INQUIRY')).toEqual({ sessionType: 'INQUIRY', difficulty: 'standard' });
  });

  it('★ 简单槽包含「简单+干扰项」★ 干扰项只是加料，难度还算简单档', () => {
    expect(slotPersonaFilter('SIMPLE_INQUIRY')).toEqual({
      sessionType: 'INQUIRY',
      difficulty: { in: ['simple', 'simple_with_distractors'] },
    });
  });

  it('四种槽位都不会漏配（每个都返回带 sessionType 的条件）', () => {
    for (const slot of ['SIMPLE_INQUIRY', 'STANDARD_INQUIRY', 'HARD_INQUIRY', 'FOLLOWUP'] as const) {
      expect(slotPersonaFilter(slot), slot).toHaveProperty('sessionType');
    }
  });
});

/**
 * ★ 2026-08-28 补的一个漏 ★
 * 难度从骨架下沉到变体那一批，**训练任务派题这条路漏掉了**——它一直用
 * `persona: slotPersonaFilter(slot)`，也就是只按骨架筛。一份「骨架标准、
 * 变体覆盖成困难」的题会被派进标准槽，而困难槽里反而找不到它。不会报错，只会派错。
 * 当时零影响（库里 0 份声明覆盖），但第一份覆盖变体入库那天就会发作。
 */
describe('slotVariantFilter：难度下沉之后，筛的是变体不是骨架', () => {
  it('跟进槽不看难度，只看局型', () => {
    expect(slotVariantFilter('FOLLOWUP')).toEqual({ persona: { sessionType: 'FOLLOWUP' } });
  });

  it('困难探需槽：变体声明了 hard 算，或者没声明而骨架是 hard 也算', () => {
    const f = slotVariantFilter('HARD_INQUIRY') as { OR: Record<string, unknown>[] };
    expect(f.OR).toHaveLength(2);
    expect(f.OR[0]).toEqual({ difficulty: { in: ['hard'] }, persona: { sessionType: 'INQUIRY' } });
    expect(f.OR[1]).toEqual({ difficulty: null, persona: { sessionType: 'INQUIRY', difficulty: 'hard' } });
  });

  it('简单槽认「简单」与「简单+干扰项」两个值', () => {
    const f = slotVariantFilter('SIMPLE_INQUIRY') as { OR: Record<string, unknown>[] };
    expect(f.OR[0]).toMatchObject({ difficulty: { in: ['simple', 'simple_with_distractors'] } });
  });

  /** 两条分支必须互斥：变体声明了就不看骨架，没声明才看，不能两边都命中 */
  it('两条分支互斥——声明过的走第一条，没声明的走第二条', () => {
    const f = slotVariantFilter('STANDARD_INQUIRY') as { OR: Record<string, unknown>[] };
    expect(f.OR[0]).not.toHaveProperty('difficulty', null);
    expect(f.OR[1]).toHaveProperty('difficulty', null);
  });
});
