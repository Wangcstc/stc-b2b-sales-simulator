/**
 * 演示文案的守门测试：台词里的数字必须跟着人设走，报告不能带禁用字样，占位符不能漏填。
 *
 * ★ 出过的事 ★ 第一版台词写死「500 件、USD 1.85」，而右边价目表是 USD 12.5、客户询盘说的是 3000 张，
 * 录屏时一眼穿帮。这里用人设自己的价目表算一遍，保证对话里的数和价目表对得上。
 */
import { describe, expect, it } from 'vitest';
import { emptyFacts } from '../engine/facts';
import { FORCES } from '../engine/types';
import { addDealFacts, buildDemoReport, CUSTOMER_SCRIPT, customerLine, demoCtx, TRAINEE_SCRIPT, traineeLine } from './demo-content';

const variant = {
  product: {
    moq: { qty: 300 },
    lead_time: { bulk_days: 35 },
    price_tiers: [
      { min_qty: 300, max_qty: 999, unit_price: 12.5, incoterm: 'FOB', port: 'Ningbo' },
      { min_qty: 1000, max_qty: 2999, unit_price: 11.6, incoterm: 'FOB', port: 'Ningbo' },
      { min_qty: 3000, max_qty: null, unit_price: 10.9, incoterm: 'FOB', port: 'Ningbo' },
    ],
  },
  openCard: { inquiry_text: 'We need 3000 sleeping pads for our stores. Please send your best price.' },
  persona: { sessionType: 'INQUIRY' },
};

describe('演示文案', () => {
  const ctx = demoCtx(variant);

  it('数量取客户询盘里自己说的，价格取价目表对应档位', () => {
    expect(ctx.qtyNum).toBe(3000);
    expect(ctx.price).toBe('10.90');
    expect(ctx.term).toBe('FOB Ningbo');
    expect(ctx.lead).toBe('35');
  });

  it('客户没说数量时，取第二档的起点，不低于起订量', () => {
    const c = demoCtx({ ...variant, openCard: { inquiry_text: 'Please send more information.' } });
    expect(c.qtyNum).toBe(1000);
    expect(c.price).toBe('11.60');
  });

  it('18 轮台词一个占位符都不许漏填', () => {
    for (let t = 1; t <= 18; t += 1) {
      expect(traineeLine(t, ctx), `业务员第 ${t} 轮`).not.toMatch(/[{}]/);
      expect(customerLine(t, ctx), `客户第 ${t} 轮`).not.toMatch(/[{}]/);
    }
    expect(TRAINEE_SCRIPT.length).toBe(CUSTOMER_SCRIPT.length);
  });

  it('跟进局前两轮换成跟进的口吻，后面接着通用台词', () => {
    const f = demoCtx({ ...variant, persona: { sessionType: 'FOLLOWUP' } });
    expect(traineeLine(1, f)).toMatch(/following up/);
    expect(traineeLine(3, f)).toBe(traineeLine(3, ctx));
  });

  it('报告走真的 buildReport：七节齐全、七力证据是这一局真说过的话、没有 L 等级字样', () => {
    const facts = emptyFacts([]);
    addDealFacts(facts, 12, ctx);
    const forceScores = Object.fromEntries(FORCES.map((f) => [f, 3])) as Record<(typeof FORCES)[number], number>;
    const { reportMd, forces } = buildDemoReport({
      drillId: 'DEMO-X-A03-GB-001-2026-11-12-001',
      turns: 12,
      difficulty: 'standard',
      followup: false,
      ctx,
      exitReason: null,
      facts,
      forceScores,
      rawScore: 70,
      tier: 'D4',
      coverage: 1,
      progress: 1,
      answerQuality: 1,
      imprecise: false,
      coachQa: true,
    });
    for (const h of ['一、你的答案盘点', '二、本局结论', '三、客观事实表', '四、七力评分与证据链', '五、逐段点评', '六、掀开客户暗牌', '七、这一局只练一个动作']) {
      expect(reportMd).toContain(h);
    }
    for (const f of FORCES) {
      const e = forces[f]!.evidence[0]!;
      expect(traineeLine(e.turn, ctx)).toBe(e.quote);
    }
    expect(reportMd).toContain('USD 10.90');
    expect(reportMd).not.toMatch(/\bL[1-5]\b|能力段位/);
  });

  it('证据不足的局报告里不给精确分数', () => {
    const facts = emptyFacts([]);
    const forceScores = Object.fromEntries(FORCES.map((f) => [f, 1])) as Record<(typeof FORCES)[number], number>;
    const { reportMd } = buildDemoReport({
      drillId: 'DEMO-X-A03-GB-001-2026-11-12-002',
      turns: 5,
      difficulty: 'standard',
      followup: false,
      ctx,
      exitReason: null,
      facts,
      forceScores,
      rawScore: null,
      tier: undefined,
      coverage: 0.4,
      progress: 0,
      answerQuality: null,
      imprecise: true,
      coachQa: false,
    });
    expect(reportMd).toContain('本局证据不足以给出精确局分');
  });
});
