/**
 * 引文校验专项测试（步骤 30 DoD：伪造引文 100% 被降为 INSUFFICIENT）
 *
 * 没有这一步，"强制取证"就只是 prompt 里的一句空话——模型会编出看起来很像的引文。
 */
import { describe, it, expect } from 'vitest';
import type { ScoreOutput } from './types';
import { verifyEvidence } from './scoring';

const messages = [
  { turn: 1, content: 'Hi Miguel, may I confirm the size? We have 1.2L and 2.0L containers.' },
  { turn: 2, content: 'Is 100 pcs the total for all 3 colors together, or 100 pcs for each color?' },
  { turn: 3, content: 'Do you need your own logo? We can print it on the color box.' },
];

const item = (score: number, evidence: { turn: number; quote: string }[]) => ({
  score: score as 1,
  evidence,
  anchor: '锚点',
  next_action: '下一步',
});

describe('★ 引文校验（步骤 30 DoD）★', () => {
  it('伪造引文 100% 被降为 INSUFFICIENT', () => {
    const fabricated: ScoreOutput = {
      insight: item(5, [{ turn: 2, quote: '我问了他清关能力和付款方式' }]),
      guidance: item(5, [{ turn: 1, quote: 'Shall I hold a production slot for you?' }]),
      solution: item(4, [{ turn: 99, quote: 'anything' }]),
      trust: item(4, [{ turn: 3, quote: 'I will give you a 20% discount' }]),
    };
    const out = verifyEvidence(fabricated, messages);
    for (const f of ['insight', 'guidance', 'solution', 'trust'] as const) {
      expect(out[f]!.score).toBe('INSUFFICIENT');
      expect(out[f]!.evidence).toHaveLength(0);
    }
  });

  it('真引文原样保留，分数不动', () => {
    const real: ScoreOutput = {
      insight: item(5, [{ turn: 2, quote: 'the total for all 3 colors together' }]),
      trust: item(3, [{ turn: 3, quote: 'print it on the color box' }]),
    };
    const out = verifyEvidence(real, messages);
    expect(out.insight!.score).toBe(5);
    expect(out.trust!.score).toBe(3);
    expect(out.insight!.evidence).toHaveLength(1);
  });

  it('真假混合时只留真的，分数保住', () => {
    const mixed: ScoreOutput = {
      guidance: item(4, [
        { turn: 1, quote: 'may I confirm the size' },
        { turn: 1, quote: '这句是编的' },
      ]),
    };
    const out = verifyEvidence(mixed, messages);
    expect(out.guidance!.score).toBe(4);
    expect(out.guidance!.evidence).toHaveLength(1);
    expect(out.guidance!.evidence[0]!.quote).toBe('may I confirm the size');
  });

  it('大小写、空格、标点差异不算伪造', () => {
    const loose: ScoreOutput = {
      insight: item(5, [{ turn: 2, quote: 'IS 100 PCS THE TOTAL, for all 3 colors together?' }]),
    };
    expect(verifyEvidence(loose, messages).insight!.score).toBe(5);
  });

  it('NA 与 INSUFFICIENT 不受校验影响', () => {
    const na: ScoreOutput = {
      negotiation: { score: 'NA', evidence: [], anchor: '本人设不激活', next_action: '' },
      stability: { score: 'INSUFFICIENT', evidence: [], anchor: '', next_action: '' },
    };
    const out = verifyEvidence(na, messages);
    expect(out.negotiation!.score).toBe('NA');
    expect(out.negotiation!.anchor).toBe('本人设不激活');
    expect(out.stability!.score).toBe('INSUFFICIENT');
  });
});
