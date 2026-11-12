import { describe, expect, it, vi } from 'vitest';

vi.mock('../admin-audit', () => ({ audit: async () => undefined }));

import { questionStats, suggestionsFor, type QuestionInfo, type SessionRow } from './feedback';
import { FEEDBACK_RULES } from '../../../standards/index';

// 题和局全是虚构的
const info: QuestionInfo = {
  rowId: 'row1',
  bankId: 'bank-test0001',
  variantId: 'B02-DE-001',
  typeName: 'B02 比价试单型',
  pool: 'exam',
  cards: ['H1_budget', 'H2_quantity'],
  activeForces: ['insight', 'guidance', 'trust'],
};
const row = (score: number | null, extra: Partial<SessionRow> = {}): SessionRow => ({
  mode: 'ADMISSION_EXAM',
  score,
  redlines: [],
  exitReason: 'manual_end',
  forces: { insight: 4, guidance: 3, trust: 2 },
  unlocked: [{ key: 'H1_budget', phrase: 'What is your target price?' }],
  ...extra,
});

describe('回流：每道题的实战统计', () => {
  it('通过率、平均分、红线率、客户放弃率、最弱的力、暗牌挖出率', () => {
    const rows = [row(80), row(70), row(50, { redlines: ['R1'], exitReason: 'patienceZero' }), row(null)];
    const s = questionStats(info, rows);
    expect(s.sessions).toBe(4);
    expect(s.scored).toBe(3);
    expect(s.passRate).toBeCloseTo(2 / 3);
    expect(s.avgScore).toBeCloseTo(200 / 3);
    expect(s.redlineRate).toBe(0.25);
    expect(s.gaveUpRate).toBe(0.25);
    expect(s.weakestForce).toMatchObject({ force: 'trust', label: '信任力' });
    expect(s.cardRates).toEqual([
      { key: 'H1_budget', rate: 1 },
      { key: 'H2_quantity', rate: 0 },
    ]);
    // 局数不够时不判「常见失分点」
    expect(s.rareCards).toEqual([]);
  });

  it('被套话破解：同一张暗牌的解锁大多是同一句话（近似说法算一句）', () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(70, { unlocked: [{ key: 'H1_budget', phrase: i < 5 ? 'What is your target price??' : 'Could you share how much budget you have for this?' }] }));
    rows[1]!.unlocked[0]!.phrase = 'what is your target price';
    const s = questionStats(info, rows);
    expect(s.onePhrase).toMatchObject({ key: 'H1_budget', unlocks: 6 });
    expect(s.onePhrase!.share).toBeCloseTo(5 / 6);
  });
});

describe('回流：回炉建议', () => {
  // 每局挖暗牌的说法都不一样（真人不会句句照抄），免得被当成「套话破解」
  const ASK = [
    'What price range are you aiming for',
    'Do you already have a supplier quote to compare with',
    'How much did you pay last season',
    'Is there a budget approved by your manager',
    'Which retail price will these sell at',
    'Shall I prepare two options at different levels',
    'Are you comparing us with factories in Vietnam',
    'What margin does your shop need',
    'Could the order size change the price for you',
    'When does your finance team set the annual budget',
    'Would a lower spec work if the cost is tight',
    'Do you pay by TT or LC usually',
    'Who signs off on the final price',
    'Is freight included in your target',
    'What happened with your last order cost',
    'Can you tell me the ceiling you cannot go above',
    'Are you buying for stores or online',
    'How flexible is the number you have in mind',
    'Did your boss give you a figure',
    'Which competitor offer are you holding',
  ];
  const many = (n: number, score: number) => Array.from({ length: n }, (_, i) => row(score, { unlocked: [{ key: 'H1_budget', phrase: ASK[i % ASK.length]! }] }));

  it('局数不够不出建议', () => {
    expect(suggestionsFor(questionStats(info, many(FEEDBACK_RULES.min_sessions - 1, 90)), { canRework: true, decided: [] })).toEqual([]);
  });

  it('太容易：推荐回炉加难度；考试题能降为演习；永远有「保留」和「其他」；3 个选项 + 其他', () => {
    const [s] = suggestionsFor(questionStats(info, many(12, 90)), { canRework: true, decided: [] });
    expect(s!.kind).toBe('too_easy');
    expect(s!.options.map((o) => o.key)).toEqual(['rework', 'to_drill', 'keep', 'other']);
    expect(s!.options[0]!.recommended).toBe(true);
    expect(s!.reason).toContain('通过率 100%');
    expect(s!.reworkNote).toContain('提高难度');
  });

  it('回炉不了的题（不是抽屉做的、或在托管平台上）：不给回炉选项；演习题不给降级', () => {
    const [s] = suggestionsFor(questionStats({ ...info, pool: 'drill' }, many(12, 90)), { canRework: false, decided: [] });
    expect(s!.options.map((o) => o.key)).toEqual(['retire', 'keep', 'other']);
  });

  it('太难：理由里写出挖出率最低的暗牌', () => {
    const [s] = suggestionsFor(questionStats(info, many(12, 30)), { canRework: true, decided: [] });
    expect(s!.kind).toBe('too_hard');
    expect(s!.reason).toContain('H2_quantity');
    expect(s!.reworkNote).toContain('更好挖');
  });

  it('拍过板的建议，要再攒够一批新局才再提', () => {
    const st = questionStats(info, many(12, 90));
    expect(suggestionsFor(st, { canRework: true, decided: [{ kind: 'too_easy', sessionsAtDecision: 10 }] })).toEqual([]);
    expect(suggestionsFor(questionStats(info, many(20, 90)), { canRework: true, decided: [{ kind: 'too_easy', sessionsAtDecision: 10 }] })).toHaveLength(1);
  });
});
