/**
 * 引擎层单元测试（技术方案第 13 章）
 *
 * ★ 六条必写用例一条不许省 ★（见 describe('★ 六条必写用例 ★')）
 * 这是全项目唯一能被自动化保障的部分，覆盖率门槛 90%。
 */

import { describe, it, expect } from 'vitest';
import type { Extraction, SessionFacts, ScoreOutput, SixElement } from './types';
import { hasDelivered, quoteLines } from './types';
import { DEFAULT_RULES, isHardRedline, DRILL_TIERS } from './rules';
import { isChineseReply } from './language';
import { parseDistractors, pickDistractor } from './distractor';
import { initialState, updateState, checkExit, decideDirective, clamp, collectRedlines } from './state-machine';
import {
  didRealWork,
  turnActivity,
  emptyFacts,
  updateFacts,
  applyCustomerAnswers,
  markVolunteered,
  countCollected,
  countAskedNoAnswer,
  computeTier,
  isFormatCompliant,
  submitQuote,
  addRedline,
  recordUnlock,
  submitDeliverable,
  parseRealQuantity,
  readRealQuantity,
} from './facts';
import { detectUnlocks, checkLeak, buildLeakCorrection, emptyUnlockState, syncUnlocksToFacts } from './unlock';
import { verifyEvidence, computeSessionScore, toDrillTier, normalize, insightFactBasis } from './scoring';

// ───────────────────────── 测试夹具 ─────────────────────────

function ext(over: Partial<Extraction> = {}): Extraction {
  return { asked_elements: [], asked_question: true, ...over };
}

/** 六要素全部标记为已收集（模拟聊到后期） */
const ALL_SIX = ['product_attr', 'quantity', 'customization', 'address', 'delivery_time', 'other'] as const;

/** 六要素齐了 = 六项都问了【而且客户都答了】。2026-08-23 起「问了」不再等于「收到了」 */
function factsWithAllElements(): SessionFacts {
  let f = emptyFacts();
  f = updateFacts(f, ext({ asked_elements: [...ALL_SIX] }), 1);
  f = answered(f, [...ALL_SIX], 1);
  return { ...f, attributeDrilled: true, quantitySplitConfirmed: true };
}

/** 客户在第 turn 轮答出了这几项 */
function answered(f: SessionFacts, elements: readonly SixElement[], turn: number): SessionFacts {
  return applyCustomerAnswers(
    f,
    { answered_elements: elements.map((element) => ({ element, quote: '' })), vague_elements: [] },
    turn,
  );
}

const CARDS = {
  H1: {
    value: '每色 100，合计 300',
    unlock: '追问口径',
    unlock_patterns: ['(total|combined).{0,40}(each|per)\\s*colou?r', '(每|各)(种|个)?颜色.{0,15}(合计|总共|多少)'],
    leak_signals: ['300 total', 'each color'],
  },
  H4: {
    value: '11/15 前到马德里',
    unlock: '问期望到货时间',
    unlock_patterns: ['when do you need', '(什么时候|何时).{0,10}(要货|到货)'],
    leak_signals: ['November', 'Christmas'],
  },
  H6: {
    value: '零售连锁',
    unlock: '带利他外壳问用途',
    unlock_patterns_topic: ['retail|your business|用途'],
    unlock_patterns_framing: ['help you|so I can|帮你|方便你'],
    leak_signals: ['retail store', 'three stores'],
  },
  H7: {
    value: '让步条件',
    unlock: '需先解锁 H4',
    requires: ['H4'],
    unlock_patterns: ['guarantee'],
    leak_signals: ['5%'],
  },
};

// ───────────────────────── ★ 六条必写用例 ★ ─────────────────────────

describe('★ 六条必写用例 ★（技术方案 13 章，一条都不许省）', () => {
  it('① 数量未确认时点发送报价 → R1 触发 + trust −30', () => {
    const facts = emptyFacts(); // 数量未收集
    const { facts: after, quote } = submitQuote(
      facts,
      { lines: [{ product: '', unitPrice: 2.5, quantity: 100 }], hasQuoteSheet: false, hasScreenshot: false },
      4,
      300,
    );
    expect(after.redlines).toContain('R1');

    // 用第 3 轮的状态，避开"首条响应 +10"的干扰，单独验 R1 的 −30
    const state = { ...initialState(70), turn: 3 };
    const { state: next, hits } = updateState(state, ext(), after, DEFAULT_RULES, { quote });
    expect(hits).toContain('quoteWithoutQuantity');
    expect(next.trust).toBe(20); // 50 − 30

    // 首轮就裸报价：+10（首条直接回应）−30（裸报价）= 净 −20，两条规则都该触发
    const firstTurn = updateState(initialState(70), ext(), after, DEFAULT_RULES, { quote });
    expect(firstTurn.hits).toContain('firstReplyDirect');
    expect(firstTurn.hits).toContain('quoteWithoutQuantity');
    expect(firstTurn.state.trust).toBe(30);
  });

  it('② 连续 3 轮无新信息 → checkExit 返回 stagnant', () => {
    let state = initialState(70);
    const facts = emptyFacts();
    for (let i = 0; i < 3; i++) {
      state = updateState(state, ext({ asked_elements: [] }), facts, DEFAULT_RULES).state;
    }
    expect(state.stagnantTurns).toBe(3);
    expect(checkExit(state, facts, 'inquiry', DEFAULT_RULES)).toBe('stagnant');
  });

  it('③ 探需局第 21 轮仍未报价 → checkExit 返回 maxTurns', () => {
    const facts = emptyFacts(); // quotes 为空
    const state = { ...initialState(70), turn: 21, patience: 50, stagnantTurns: 0 };
    expect(checkExit(state, facts, 'inquiry', DEFAULT_RULES)).toBe('maxTurns');

    // 已报价则不因超轮数离场
    const quoted = submitQuote(facts, { lines: [{ product: '', unitPrice: 2, quantity: 300 }], hasQuoteSheet: true, hasScreenshot: true }, 10, 300).facts;
    expect(checkExit(state, quoted, 'inquiry', DEFAULT_RULES)).toBeNull();
  });

  it('④ 只评 3 个维度 → 双门槛拒绝出分', () => {
    const scores: ScoreOutput = {
      insight: { score: 4, evidence: [], anchor: '', next_action: '' },
      guidance: { score: 4, evidence: [], anchor: '', next_action: '' },
      solution: { score: 4, evidence: [], anchor: '', next_action: '' },
    };
    const r = computeSessionScore({ scores, sessionType: 'inquiry' });
    expect(r.precise).toBe(false);
    expect(r.evaluableCount).toBe(3);
    expect(r.rawScore).toBeUndefined();
    expect(r.reason).toContain('双门槛');
  });

  it('⑤ 评分引用了不存在的 turn → 该维度降为 INSUFFICIENT', () => {
    const messages = [{ turn: 1, content: 'Is 100 pcs the total for all 3 colors?' }];
    const out: ScoreOutput = {
      insight: { score: 5, evidence: [{ turn: 99, quote: '我从没说过这句话' }], anchor: 'x', next_action: 'y' },
      guidance: { score: 4, evidence: [{ turn: 1, quote: 'the total for all 3 colors' }], anchor: 'x', next_action: 'y' },
    };
    const verified = verifyEvidence(out, messages);
    expect(verified.insight!.score).toBe('INSUFFICIENT');
    expect(verified.insight!.anchor).toContain('证据不足');
    // 引文对得上的维度不受影响
    expect(verified.guidance!.score).toBe(4);
  });

  it('⑥ 泄露检查命中未解锁暗牌 → 报出命中项（供调用方重生成）', () => {
    const st = emptyUnlockState();
    const hits = checkLeak(CARDS, 'We need them before November, it is for our Christmas stock.', st);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.card)).toContain('H4');

    const correction = buildLeakCorrection(hits);
    expect(correction).toContain('November');
    expect(correction).toContain('还没有问到');

    // 解锁之后同样的话不再算泄露
    const unlocked = { unlocked: ['H4'], unlockedAt: { H4: 3 } };
    expect(checkLeak(CARDS, 'We need them before November.', unlocked)).toHaveLength(0);
  });
});

// ───────────────────────── 状态机 ─────────────────────────

describe('状态机', () => {
  it('三个值一律夹在 0–100（08-04 出现过 trust=145）', () => {
    expect(clamp(145)).toBe(100);
    expect(clamp(-30)).toBe(0);
    let state = { ...initialState(70), trust: 95 };
    state = updateState(state, ext({ has_altruistic_framing: true, affirmed_customer: true }), emptyFacts(), DEFAULT_RULES).state;
    expect(state.trust).toBeLessThanOrEqual(100);
  });

  it('耐心归零 → patienceZero', () => {
    const state = { ...initialState(70), patience: 0 };
    expect(checkExit(state, emptyFacts(), 'inquiry', DEFAULT_RULES)).toBe('patienceZero');
  });

  it('回复完不抛问题每轮 −10（08-05 模型漏执行的那条）', () => {
    const s0 = initialState(70);
    const withQ = updateState(s0, ext({ asked_question: true, asked_elements: ['quantity'] }), emptyFacts(), DEFAULT_RULES).state;
    const noQ = updateState(s0, ext({ asked_question: false, asked_elements: ['quantity'] }), emptyFacts(), DEFAULT_RULES).state;
    expect(withQ.patience - noQ.patience).toBe(10);
  });

  it('纯函数：同样输入永远同样输出', () => {
    const s = initialState(70);
    const f = emptyFacts();
    const e = ext({ asked_elements: ['quantity'], has_altruistic_framing: true });
    const a = updateState(s, e, f, DEFAULT_RULES);
    const b = updateState(s, e, f, DEFAULT_RULES);
    expect(a).toEqual(b);
    // 且不改动入参
    expect(s.turn).toBe(0);
  });

  it('decideDirective 按耐心分四档，且不含任何"你自己判断"的措辞', () => {
    expect(decideDirective({ ...initialState(70), patience: 90 }).tone).toBe('normal');
    expect(decideDirective({ ...initialState(70), patience: 50 }).tone).toBe('shorter');
    expect(decideDirective({ ...initialState(70), patience: 20 }).tone).toBe('impatient');
    expect(decideDirective({ ...initialState(70), patience: 0 }).tone).toBe('leaving');

    for (const p of [90, 50, 20, 0]) {
      const d = decideDirective({ ...initialState(70), patience: p });
      expect(d.lines.join('')).not.toMatch(/你自己判断|你觉得还有多少/);
    }
  });

  it('空催触发 R3 扣耐心；发目录且未收产品属性扣兴趣', () => {
    const r = updateState(initialState(70), ext({ is_empty_chase: true }), emptyFacts(), DEFAULT_RULES);
    expect(r.hits).toContain('emptyChase');
    const c = updateState(initialState(70), ext({ sent_catalog: true }), emptyFacts(), DEFAULT_RULES);
    expect(c.hits).toContain('catalogBeforeNeeds');
    expect(c.state.interest).toBe(50);
  });

  it('因怀疑降低服务投入只生成 R2 复核信号', () => {
    const flagged = updateState(
      initialState(70),
      ext({ low_investment_on_suspicion: true }),
      emptyFacts(),
      DEFAULT_RULES,
    );
    expect(flagged.hits).toContain('lowInvestmentOnSuspicion');
    expect(collectRedlines(flagged.hits, DEFAULT_RULES)).toContain('R2');

    const dueDiligence = updateState(
      initialState(70),
      ext({ contradiction_probe: true, low_investment_on_suspicion: false }),
      emptyFacts(),
      DEFAULT_RULES,
    );
    expect(dueDiligence.hits).not.toContain('lowInvestmentOnSuspicion');
    expect(collectRedlines(dueDiligence.hits, DEFAULT_RULES)).not.toContain('R2');
  });
});

// ───────────────────────── 难度系数只动局分，不动门槛 ─────────────────────────

describe('★ 难度系数：调的是「拿到 65 有多难」★', () => {
  const perfectish = (): ScoreOutput => ({
    insight: { score: 4, evidence: [], anchor: '', next_action: '' },
    guidance: { score: 4, evidence: [], anchor: '', next_action: '' },
    solution: { score: 4, evidence: [], anchor: '', next_action: '' },
    trust: { score: 4, evidence: [], anchor: '', next_action: '' },
    closing: { score: 3, evidence: [], anchor: '', next_action: '' },
    negotiation: { score: 3, evidence: [], anchor: '', next_action: '' },
    stability: { score: 3, evidence: [], anchor: '', next_action: '' },
  });

  it('α=1 与不传系数逐位相同——默认行为一个字节都没变', () => {
    const a = computeSessionScore({ scores: perfectish(), sessionType: 'inquiry' });
    const b = computeSessionScore({ scores: perfectish(), sessionType: 'inquiry', difficultyFactor: 1 });
    expect(a.rawScore).toBe(b.rawScore);
    expect(a.baselineScore).toBe(a.rawScore);
  });

  it('系数越大局分越低，同一份七力', () => {
    const at = (f: number) =>
      computeSessionScore({ scores: perfectish(), sessionType: 'inquiry', difficultyFactor: f }).rawScore!;
    expect(at(0.8)).toBeGreaterThan(at(1));
    expect(at(1.2)).toBeLessThan(at(1));
  });

  it('★原始分照常留着★ 报告要能说清「原始 X → 系数 f → 最终 Y」', () => {
    const r = computeSessionScore({ scores: perfectish(), sessionType: 'inquiry', difficultyFactor: 1.2 });
    expect(r.difficultyFactor).toBe(1.2);
    expect(r.baselineScore).toBeGreaterThan(r.rawScore!);
    // 折算前后是同一局，覆盖率这类事实不受影响
    expect(r.precise).toBe(true);
  });

  it('段位跟着折算后的分走——这正是「更难拿到高分」的意思', () => {
    const easy = computeSessionScore({ scores: perfectish(), sessionType: 'inquiry', difficultyFactor: 0.6 });
    const hard = computeSessionScore({ scores: perfectish(), sessionType: 'inquiry', difficultyFactor: 1.5 });
    expect(toDrillTier(easy.rawScore!)).not.toBe(toDrillTier(hard.rawScore!));
  });

  it('★门槛不在这条链路上★ 分档边界永远是 65，系数碰不到它', () => {
    // D4 下沿 = 准入门槛。系数无论怎么调，这条线本身不动。
    expect(DRILL_TIERS.find((t) => t.tier === 'D4')!.min).toBe(65);
    expect(toDrillTier(65)).toBe('D4');
    expect(toDrillTier(64)).toBe('D3');
  });

  it('脏系数退回 1.0，绝不静默改分', () => {
    const dirty = computeSessionScore({
      scores: perfectish(),
      sessionType: 'inquiry',
      difficultyFactor: NaN,
    });
    const normal = computeSessionScore({ scores: perfectish(), sessionType: 'inquiry' });
    expect(dirty.rawScore).toBe(normal.rawScore);
  });
});

// ───────────────────────── 红线④：用中文作答 ─────────────────────────

describe('★ 红线④ 用中文作答 ★', () => {
  it('只认汉字，不认中文标点', () => {
    // 一句纯英文里蹦出一个「，」是输入法没切干净，不是"用中文作答"。
    // 按标点判会把大量正常英文消息误判成碰红线——而红线是要扣分、要写进报告的。
    expect(isChineseReply('Our MOQ is 500 pcs.')).toBe(false);
    expect(isChineseReply('Our MOQ is 500 pcs，thanks')).toBe(false);
    expect(isChineseReply('您好，请问需要多少？')).toBe(true);
    expect(isChineseReply('Our MOQ is 500，最少五百个')).toBe(true); // 中英混也算：一样读不懂
    expect(isChineseReply('')).toBe(false);
  });

  it('命中即扣信任与耐心，并记红线 R4', () => {
    const base = initialState(70);
    const zh = updateState(base, ext({ replied_in_chinese: true }), emptyFacts(), DEFAULT_RULES);
    const en = updateState(base, ext(), emptyFacts(), DEFAULT_RULES);

    expect(zh.hits).toContain('repliedInChinese');
    expect(en.hits).not.toContain('repliedInChinese');
    expect(collectRedlines(zh.hits, DEFAULT_RULES)).toContain('R4');

    // ★ 比差值，不比绝对值 ★ 同一轮里还有首轮加分、自然衰减等好几条规则在动，
    // 写死绝对值的话，将来任何一条无关规则改了数值，这个测试都会红——
    // 而它本该只盯着"中文这一条扣了多少"。
    expect(en.state.trust - zh.state.trust).toBe(20);
    expect(en.state.patience - zh.state.patience).toBe(10);
  });

  it('R4 是纯代码判定，不进复核队列', () => {
    expect(isHardRedline('R4')).toBe(true);
  });

  it('★客户看不懂★ 中文轮的指令覆盖一切语气档位', () => {
    const d = decideDirective(initialState(70), { chineseReceived: true });
    expect(d.chineseReceived).toBe(true);
    expect(d.lines.join('')).toContain('看不懂');
    expect(d.lines.join('')).toContain('不许回答他任何问题');
  });

  it('人已经走了就不必再演一次听不懂', () => {
    const gone = { ...initialState(70), patience: 0 };
    expect(decideDirective(gone, { chineseReceived: true }).tone).toBe('leaving');
  });

  it('不传 chineseReceived 时行为完全不变', () => {
    const s = initialState(70);
    expect(decideDirective(s)).toEqual(decideDirective(s, {}));
    expect(decideDirective(s).tone).toBe('normal');
  });

});

// ───────────────────────── 事实表 ─────────────────────────

describe('事实表', () => {
  it('报价档位与格式合规（第一课 4 章）', () => {
    expect(computeTier(99)).toBe('A');
    expect(computeTier(250)).toBe('B');
    expect(computeTier(690)).toBe('C');

    expect(isFormatCompliant('A', false, false)).toBe(true);
    expect(isFormatCompliant('B', false, false)).toBe(false);
    expect(isFormatCompliant('B', false, true)).toBe(true);
    expect(isFormatCompliant('C', false, true)).toBe(false);
    expect(isFormatCompliant('C', true, true)).toBe(true);
  });

  it('★数量陷阱：误判 100 → B 档，真实 300 → C 档★', () => {
    const f = emptyFacts();
    const wrong = submitQuote(f, { lines: [{ product: '', unitPrice: 2.5, quantity: 100 }], hasQuoteSheet: false, hasScreenshot: true }, 6, 300);
    expect(wrong.quote.total).toBe(250);
    expect(wrong.quote.tier).toBe('B');
    expect(wrong.quote.quantityMismatch).toBe(true);
    expect(wrong.quote.formatCompliant).toBe(true); // B 档有截图就合规——档位判错才是真问题

    const right = submitQuote(f, { lines: [{ product: '', unitPrice: 2.3, quantity: 300 }], hasQuoteSheet: true, hasScreenshot: true }, 10, 300);
    expect(right.quote.total).toBe(690);
    expect(right.quote.tier).toBe('C');
    expect(right.quote.quantityMismatch).toBe(false);
  });

  it('★source 列：客户主动送的不算新人功劳★', () => {
    let f = emptyFacts();
    f = updateFacts(f, ext({ asked_elements: ['product_attr'] }), 1); // 新人问出
    f = answered(f, ['product_attr'], 1); // 客户答了 → 记他的功劳
    f = markVolunteered(f, ['delivery_time'], 11); // 没人问，客户主动吐

    expect(countCollected(f)).toBe(2);
    expect(countCollected(f, 'asked')).toBe(1);
    expect(countCollected(f, 'volunteered')).toBe(1);
    expect(f.elements.delivery_time.source).toBe('volunteered');

    const basis = insightFactBasis(f);
    expect(basis.askedCount).toBe(1);
    expect(basis.volunteeredCount).toBe(1);
  });

  it('★preset：前情已定的要素既不算功劳也不算缺失★', () => {
    // 跟进局：订单都建好了，产品/数量/定制/地址/交期在前情里写死了
    const f = emptyFacts(['product_attr', 'quantity', 'customization', 'address', 'delivery_time']);

    expect(countCollected(f)).toBe(5);
    expect(f.elements.product_attr.source).toBe('preset');
    expect(f.elements.other.collected).toBe(false);

    // 关键：洞察力只数 asked，preset 一项都不进——它不该被算成"他问出来的"
    const basis = insightFactBasis(f);
    expect(basis.askedCount).toBe(0);
    expect(basis.volunteeredCount).toBe(0);
  });

  it('★preset 锁死：前情写过的他再问一遍，不算功劳★', () => {
    let f = emptyFacts(['product_attr']);
    f = updateFacts(f, ext({ asked_elements: ['product_attr'] }), 3);
    // 仍是 preset，不会被改写成 asked——订单都建好了还问产品参数，那是没看前情
    expect(f.elements.product_attr.source).toBe('preset');
    expect(insightFactBasis(f).askedCount).toBe(0);
  });

  // ── 2026-08-19 业务员反馈：六要素判定的三类假信号 ──
  // 这一组是回归闸。老实现「问了 = 收到了」，三条全会红。
  describe('★ 问了 ≠ 收到了 ★', () => {
    it('问了、客户没答 → 不打勾，停在 asked_no_answer', () => {
      let f = emptyFacts();
      f = updateFacts(f, ext({ asked_elements: ['quantity'] }), 1);

      expect(f.elements.quantity.status).toBe('asked_no_answer');
      expect(f.elements.quantity.collected).toBe(false);
      expect(countCollected(f)).toBe(0);
      expect(countAskedNoAnswer(f)).toBe(1);
    });

    it('★P0：问了没人答就报价，红线① 必须触发★', () => {
      // 这正是老实现漏判的场景——问一句 "How many?"、客户没答、直接报价。
      // `collected` 当时已经是 true，于是全系统唯一能作硬否决的判定形同虚设。
      let f = emptyFacts();
      f = updateFacts(f, ext({ asked_elements: ['quantity'] }), 1);

      const q = submitQuote(f, { lines: [{ product: '', unitPrice: 2, quantity: 500 }], hasQuoteSheet: true, hasScreenshot: true }, 2, 500);
      expect(q.facts.redlines).toContain('R1');
      expect(q.quote.quantityConfirmed).toBe(false);
    });

    it('客户答了 → 打勾，且记成业务员的功劳', () => {
      let f = emptyFacts();
      f = updateFacts(f, ext({ asked_elements: ['quantity'] }), 1);
      f = applyCustomerAnswers(
        f,
        { answered_elements: [{ element: 'quantity', quote: 'We need 2,000 pcs.' }], vague_elements: [] },
        1,
      );

      expect(f.elements.quantity.status).toBe('collected');
      expect(f.elements.quantity.source).toBe('asked');
      expect(f.elements.quantity.gotQuote).toBe('We need 2,000 pcs.');
      expect(countCollected(f, 'asked')).toBe(1);

      // 确认过数量再报价，红线① 就不该触发
      const q = submitQuote(f, { lines: [{ product: '', unitPrice: 2, quantity: 2000 }], hasQuoteSheet: true, hasScreenshot: true }, 2, 2000);
      expect(q.facts.redlines).not.toContain('R1');
      expect(q.quote.quantityConfirmed).toBe(true);
    });

    it('客户只给模糊回答（a lot / depends）→ 不算收集到，只打模糊标', () => {
      let f = emptyFacts();
      f = updateFacts(f, ext({ asked_elements: ['quantity'] }), 1);
      f = applyCustomerAnswers(f, { answered_elements: [], vague_elements: ['quantity'] }, 1);

      expect(f.elements.quantity.status).toBe('asked_no_answer');
      expect(f.elements.quantity.vague).toBe(true);
      expect(countCollected(f)).toBe(0);
    });

    it('没人问、客户自己吐的 → 算收集到但不算功劳', () => {
      let f = emptyFacts();
      f = applyCustomerAnswers(
        f,
        { answered_elements: [{ element: 'delivery_time', quote: 'before Nov 15' }], vague_elements: [] },
        3,
      );

      expect(f.elements.delivery_time.status).toBe('collected');
      expect(f.elements.delivery_time.source).toBe('volunteered');
      expect(countCollected(f, 'asked')).toBe(0);
      expect(insightFactBasis(f).askedCount).toBe(0);
    });

    it('反复追问同一项不叠加，askedTurn 记第一次', () => {
      let f = emptyFacts();
      f = updateFacts(f, ext({ asked_elements: ['address'] }), 2);
      f = updateFacts(f, ext({ asked_elements: ['address'] }), 5);
      expect(f.elements.address.askedTurn).toBe(2);
    });

    it('老数据（只有 collected 没有 status）读起来行为不变', () => {
      // 2026-08-23 之前落库的 Session.facts JSON 里没有 status 列
      const legacy = { ...emptyFacts() };
      legacy.elements = {
        ...legacy.elements,
        quantity: { collected: true, turn: 3, source: 'asked' },
      };
      expect(countCollected(legacy)).toBe(1);
      expect(countCollected(legacy, 'asked')).toBe(1);
      const q = submitQuote(legacy, { lines: [{ product: '', unitPrice: 1, quantity: 10 }], hasQuoteSheet: true, hasScreenshot: true }, 4, 10);
      expect(q.facts.redlines).not.toContain('R1');
    });
  });

  it('探需局不传 preset 时行为完全不变', () => {
    const f = emptyFacts();
    expect(countCollected(f)).toBe(0);
    expect(f.elements.product_attr.collected).toBe(false);
  });

  it('已记为 asked 的要素不会被后来的 volunteered 覆盖', () => {
    let f = emptyFacts();
    f = updateFacts(f, ext({ asked_elements: ['quantity'] }), 2); // 第 2 轮问的
    f = markVolunteered(f, ['quantity'], 8); // 客户第 8 轮才给
    // ★ 问在前就算他的功劳 ★ 哪怕客户拖到第 8 轮才答，source 仍是 asked
    expect(f.elements.quantity.source).toBe('asked');
    expect(f.elements.quantity.askedTurn).toBe(2);
    expect(f.elements.quantity.gotTurn).toBe(8);
  });

  it('六要素全部由新人问出才记 turnsToCollectAll', () => {
    const f = factsWithAllElements();
    expect(f.turnsToCollectAll).toBe(1);

    let g = emptyFacts();
    g = updateFacts(g, ext({ asked_elements: ['product_attr'] }), 1);
    g = answered(g, ['product_attr'], 1);
    g = markVolunteered(g, ['quantity', 'customization', 'address', 'delivery_time', 'other'], 2);
    expect(g.turnsToCollectAll).toBeNull();
  });

  it('红线与解锁记录不重复写入', () => {
    let f = addRedline(emptyFacts(), 'R3');
    f = addRedline(f, 'R3');
    expect(f.redlines).toEqual(['R3']);

    f = recordUnlock(f, 'H1', 3);
    f = recordUnlock(f, 'H1', 9);
    expect(f.unlockedCards).toEqual([{ key: 'H1', turn: 3 }]);
  });

  it('每轮是否抛问题按轮次记录', () => {
    let f = emptyFacts();
    f = updateFacts(f, ext({ asked_question: true }), 1);
    f = updateFacts(f, ext({ asked_question: false }), 2);
    expect(f.askedQuestionByTurn).toEqual([true, false]);
  });

  it('跟进级别与由头落表', () => {
    let f = emptyFacts();
    f = updateFacts(f, ext({ followup_level: '2', followup_has_hook: true }), 3);
    expect(f.followupLevelsUsed).toEqual([{ level: '2', hasHook: true, turn: 3 }]);
  });
});

// ───────────────────────── 解锁判定 ─────────────────────────

// ───────────────────────── 发产品目录：动作要真实发生，但不免罪 ─────────────────────────

describe('★ 发产品目录是动作不是一句话 ★（2026-08-19 反馈 #4）', () => {
  it('投递一次就落进事实表，带轮次', () => {
    const f = submitDeliverable(emptyFacts(), 'catalog', 3);
    expect(f.deliverables).toEqual([{ turn: 3, kind: 'catalog' }]);
    expect(hasDelivered(f, 'catalog')).toBe(true);
  });

  it('没投递过就是没投递过——老局没有这一列也不许当成发过', () => {
    expect(hasDelivered(emptyFacts(), 'catalog')).toBe(false);
    // 2026-08-23 之前的历史 facts JSON 里根本没有 deliverables
    const legacy = { ...emptyFacts(), deliverables: undefined };
    expect(hasDelivered(legacy, 'catalog')).toBe(false);
  });

  it('★ 重复投递只记第一次 ★「他第几轮把目录给出去的」是判定事实，发第二遍不改变它', () => {
    const once = submitDeliverable(emptyFacts(), 'catalog', 3);
    const twice = submitDeliverable(once, 'catalog', 7);
    expect(twice.deliverables).toEqual([{ turn: 3, kind: 'catalog' }]);
  });

  it('★ 做了按钮不等于免罪 ★ 产品属性还没收到就发目录，照扣兴趣', () => {
    // 走按钮的那一轮，session-service 会把 sent_catalog 置 true，规则照常判
    const r = updateState(initialState(70), ext({ sent_catalog: true }), emptyFacts(), DEFAULT_RULES);
    expect(r.hits).toContain('catalogBeforeNeeds');
  });

  it('产品属性已经收到之后再发目录，不扣兴趣', () => {
    const collected = applyCustomerAnswers(
      updateFacts(emptyFacts(), ext({ asked_elements: ['product_attr'] }), 1),
      { answered_elements: [{ element: 'product_attr', quote: 'Stainless steel, 500ml.' }], vague_elements: [] },
      2,
    );
    const r = updateState(initialState(70), ext({ sent_catalog: true }), collected, DEFAULT_RULES);
    expect(r.hits).not.toContain('catalogBeforeNeeds');
  });

  // ★ 客户 prompt 与评分证据块的断言不在这里 ★ 这个文件是引擎无菌区的测试，
  // 引擎不许反向 import llm/。那两条在 `src/lib/deliverable.test.ts` 里。
});

// ───────────────────────── 多产品报价 ─────────────────────────

describe('★ 多产品报价 ★（2026-08-19 反馈 #6）', () => {
  const twoProducts = {
    lines: [
      { product: 'VC-200', unitPrice: 10, quantity: 20 },
      { product: 'VC-300', unitPrice: 5, quantity: 20 },
    ],
    hasQuoteSheet: false,
    hasScreenshot: false,
  };

  it('每一行都独立入库', () => {
    const { quote } = submitQuote(factsWithAllElements(), twoProducts, 5, 20);
    expect(quote.lines).toHaveLength(2);
    expect(quote.lines![1]).toEqual({ product: 'VC-300', unitPrice: 5, quantity: 20 });
  });

  it('总额是所有行的合计加运费', () => {
    const { quote } = submitQuote(factsWithAllElements(), { ...twoProducts, freight: 40 }, 5, 20);
    expect(quote.total).toBe(10 * 20 + 5 * 20 + 40); // 340
  });

  it('★ 档位按整份报价算，拆成两个产品不能绕过 C 档 ★', () => {
    // 两行各 200，单看每一行都是 B 档；合起来 400 是 C 档，必须报价表 + 截图
    const { quote } = submitQuote(
      factsWithAllElements(),
      {
        lines: [
          { product: 'A', unitPrice: 10, quantity: 20 },
          { product: 'B', unitPrice: 10, quantity: 20 },
        ],
        hasQuoteSheet: false,
        hasScreenshot: true,
      },
      5,
      20,
    );
    expect(quote.total).toBe(400);
    expect(quote.tier).toBe('C');
    expect(quote.formatCompliant).toBe(false); // C 档只给截图不够
  });

  it('★ 有一行报的是真实数量就不算失真 ★ 多报一个产品不该被判成填错数', () => {
    const { quote } = submitQuote(factsWithAllElements(), twoProducts, 5, 20);
    expect(quote.quantityMismatch).toBe(false);

    const wrong = submitQuote(
      factsWithAllElements(),
      { ...twoProducts, lines: [{ product: 'VC-200', unitPrice: 10, quantity: 999 }] },
      5,
      20,
    );
    expect(wrong.quote.quantityMismatch).toBe(true);
  });

  it('单产品时行为与老口径逐位相同', () => {
    const single = {
      lines: [{ product: '', unitPrice: 2.5, quantity: 100 }],
      freight: 10,
      hasQuoteSheet: false,
      hasScreenshot: false,
    };
    const { quote } = submitQuote(factsWithAllElements(), single, 3, 100);
    expect(quote.total).toBe(2.5 * 100 + 10);
    expect(quote.unitPrice).toBe(2.5); // 首行镜像，老读者还在读它
    expect(quote.quantity).toBe(100);
    expect(quote.quantityMismatch).toBe(false);
  });

  it('★ 老记录没有 lines 也要读得出来 ★ 不然历史局的报告会显示成 0 个产品', () => {
    const legacy = {
      turn: 3,
      unitPrice: 2,
      quantity: 50,
      freight: 0,
      total: 100,
      tier: 'B' as const,
      hasQuoteSheet: false,
      hasScreenshot: true,
      formatCompliant: true,
      quantityMismatch: false,
    };
    expect(quoteLines(legacy)).toEqual([{ product: '', unitPrice: 2, quantity: 50 }]);
  });

  it('贸易术语与交期不填就不写进记录（不许凭空造一个默认值）', () => {
    const { quote } = submitQuote(factsWithAllElements(), twoProducts, 5, 20);
    expect(quote.tradeTerms).toBeUndefined();
    expect(quote.leadTimeDays).toBeUndefined();
  });
});

describe('暗牌解锁', () => {
  it('追问数量口径才解锁 H1（中英都认）', () => {
    const a = detectUnlocks(CARDS, 'is 100 pcs the total for all 3 colors, or per color?', emptyUnlockState(), 3);
    expect(a.fresh).toContain('H1');

    const b = detectUnlocks(CARDS, '请问你需要哪三种颜色？每种颜色多少数量？', emptyUnlockState(), 1);
    expect(b.fresh).toContain('H1');

    const c = detectUnlocks(CARDS, 'Please send me your best price.', emptyUnlockState(), 1);
    expect(c.fresh).toHaveLength(0);
  });

  it('★裸问身份不解锁 H6，带利他外壳才解锁★', () => {
    const bare = detectUnlocks(CARDS, 'Are you a retail company or trading company?', emptyUnlockState(), 5);
    expect(bare.fresh).not.toContain('H6');

    const framed = detectUnlocks(
      CARDS,
      'Are these for retail in your own stores? I ask so I can help you choose the right packaging.',
      emptyUnlockState(),
      5,
    );
    expect(framed.fresh).toContain('H6');
  });

  it('requires 未满足则不解锁（H7 需先有 H4）', () => {
    const noPre = detectUnlocks(CARDS, 'Can I guarantee the delivery for you?', emptyUnlockState(), 6);
    expect(noPre.fresh).not.toContain('H7');

    const withPre = detectUnlocks(CARDS, 'Can I guarantee the delivery?', { unlocked: ['H4'], unlockedAt: { H4: 5 } }, 6);
    expect(withPre.fresh).toContain('H7');
  });

  it('已解锁的牌不会重复解锁，解锁轮次被记住', () => {
    const first = detectUnlocks(CARDS, 'when do you need the goods?', emptyUnlockState(), 4);
    expect(first.state.unlockedAt.H4).toBe(4);
    const again = detectUnlocks(CARDS, 'when do you need the goods?', first.state, 9);
    expect(again.fresh).toHaveLength(0);
    expect(again.state.unlockedAt.H4).toBe(4);
  });

  it('解锁状态可同步进事实表', () => {
    const st = { unlocked: ['H1', 'H4'], unlockedAt: { H1: 2, H4: 7 } };
    const f = syncUnlocksToFacts(emptyFacts(), st);
    expect(f.unlockedCards).toEqual([
      { key: 'H1', turn: 2 },
      { key: 'H4', turn: 7 },
    ]);
    // 幂等
    expect(syncUnlocksToFacts(f, st).unlockedCards).toHaveLength(2);
  });
});

// ───────────────────────── 评分 ─────────────────────────

describe('局分计算', () => {
  const full = (score: number): ScoreOutput => ({
    insight: { score: score as 1, evidence: [], anchor: '', next_action: '' },
    guidance: { score: score as 1, evidence: [], anchor: '', next_action: '' },
    solution: { score: score as 1, evidence: [], anchor: '', next_action: '' },
    trust: { score: score as 1, evidence: [], anchor: '', next_action: '' },
    closing: { score: score as 1, evidence: [], anchor: '', next_action: '' },
  });

  it('人设 1 五项可评 → 覆盖率 85%，双门槛达标', () => {
    const r = computeSessionScore({ scores: full(3), sessionType: 'inquiry' });
    expect(r.precise).toBe(true);
    expect(r.coverage).toBeCloseTo(0.85, 5);
    expect(r.evaluableCount).toBe(5);
    expect(r.rawScore).toBe(50);
    expect(r.tier).toBe('D3');
  });

  it('段位分档边界', () => {
    expect(toDrillTier(0)).toBe('D1');
    expect(toDrillTier(24)).toBe('D1');
    expect(toDrillTier(25)).toBe('D2');
    expect(toDrillTier(49)).toBe('D2');
    expect(toDrillTier(50)).toBe('D3');
    expect(toDrillTier(64)).toBe('D3');
    expect(toDrillTier(65)).toBe('D4');
    expect(toDrillTier(79)).toBe('D4');
    expect(toDrillTier(80)).toBe('D5');
    expect(toDrillTier(100)).toBe('D5');
  });

  it('NA 与 INSUFFICIENT 都退出分母', () => {
    const scores: ScoreOutput = {
      ...full(4),
      negotiation: { score: 'NA', evidence: [], anchor: '', next_action: '' },
      stability: { score: 'INSUFFICIENT', evidence: [], anchor: '', next_action: '' },
    };
    const r = computeSessionScore({ scores, sessionType: 'inquiry' });
    expect(r.evaluableCount).toBe(5);
    expect(r.coverage).toBeCloseTo(0.85, 5);
  });

  it('红旗只剩「高招式·零推进」一条，复盘答得再差也不进评分（08-19 反馈 #9）', () => {
    const high = computeSessionScore({ scores: full(4), sessionType: 'inquiry', progress: 0 });
    expect(high.rawScore).toBe(75);
    expect(high.flags).toContain('high_skill_zero_progress');

    // ★ 王铖裁定：复盘 5 问撇出评分 ★ 作答质量 0 分也不许再产出「高分·零认知」红旗
    const zeroInsight = computeSessionScore({ scores: full(4), sessionType: 'inquiry', answerQuality: 0 });
    expect(zeroInsight.flags).not.toContain('high_score_zero_insight');
    expect(zeroInsight.flags).toHaveLength(0);
    // 局分本身一点不受影响
    expect(zeroInsight.rawScore).toBe(75);

    const low = computeSessionScore({ scores: full(2), sessionType: 'inquiry', progress: 0 });
    expect(low.rawScore).toBeLessThan(60);
    expect(low.flags).toHaveLength(0);
  });

  it('跟进局用通用权重', () => {
    const r = computeSessionScore({ scores: full(3), sessionType: 'followup' });
    expect(r.coverage).toBeCloseTo(0.8, 5);
    expect(r.precise).toBe(true);
  });

  it('normalize 忽略大小写、空白与标点', () => {
    expect(normalize('Is 100 pcs, the TOTAL?')).toBe(normalize('is100pcsthetotal'));
  });
});

/**
 * 干扰项选择（2026-08-06 新增）
 *
 * ★ 为什么专门测 ★ 这套逻辑此前整整缺失——人设 JSON 写了 distractors、库里也存了，
 * 引擎却一次都没读过，导致 P1 标称「简单 + 干扰项」实跑却一个都不出。
 * 缺过一次的东西，得有测试钉住。
 */
describe('干扰项选择', () => {
  const D = [
    { code: 'D1', turn_range: [1, 3] as [number, number], content: '先给个价' },
    { code: 'D2', turn_range: [4, 6] as [number, number], content: '要实物视频' },
  ];

  it('落在窗口内才抛', () => {
    expect(pickDistractor(D, 2, [])?.code).toBe('D1');
    expect(pickDistractor(D, 5, [])?.code).toBe('D2');
  });

  it('窗口外不抛——补抛一个早该出现的问题只会让对话前言不搭后语', () => {
    expect(pickDistractor(D, 7, [])).toBeNull();
    expect(pickDistractor(D, 4, ['D2'])).toBeNull();
  });

  it('抛过的不再抛，否则客户变复读机', () => {
    expect(pickDistractor(D, 2, ['D1'])).toBeNull();
  });

  it('一轮最多一个，多个候选时先抛快过期的那个', () => {
    const overlap = [
      { code: 'A', turn_range: [1, 9] as [number, number], content: 'a' },
      { code: 'B', turn_range: [1, 2] as [number, number], content: 'b' },
    ];
    expect(pickDistractor(overlap, 1, [])?.code).toBe('B');
  });

  it('脏数据直接丢掉，不许把整局带崩', () => {
    expect(parseDistractors(null)).toEqual([]);
    expect(parseDistractors([{ code: 'X' }, { code: 'Y', content: 'y', turn_range: [1, 2] }])).toHaveLength(1);
  });
});

// ───────────────────────── 数量失真：拿不准就不判（2026-08-24） ─────────────────────────

describe('★ 数量失真不许误报 ★（08-19 反馈 #5）', () => {
  const oneLine = (quantity: number) => ({
    lines: [{ product: 'VC-200', unitPrice: 2, quantity }],
    hasQuoteSheet: true,
    hasScreenshot: true,
  });

  it('★ 核心回归：暗牌里读不出真实数量时，一律不判失真 ★', () => {
    // 这就是那个洞：老代码取不到就当 0，而没人报 0 个 → 每一份报价都被判失真。
    const { quote } = submitQuote(factsWithAllElements(), oneLine(2000), 5, null);
    expect(quote.quantityMismatch).toBe(false);
    expect(quote.quantityChecked).toBe(false);
  });

  it('有真实数量时照旧判，报对不算失真、报错算', () => {
    expect(submitQuote(factsWithAllElements(), oneLine(300), 5, 300).quote.quantityMismatch).toBe(false);
    expect(submitQuote(factsWithAllElements(), oneLine(100), 5, 300).quote.quantityMismatch).toBe(true);
    expect(submitQuote(factsWithAllElements(), oneLine(300), 5, 300).quote.quantityChecked).toBe(true);
  });

  describe('parseRealQuantity：读得准才给数', () => {
    it('「合计 N」最优先——首单每款 600、合计 1200，答案是 1200 不是 600', () => {
      expect(parseRealQuantity('首单按每款 600 pcs 采购（两款各 600，合计 1200 pcs）')).toBe(1200);
    });

    it('P1-V1 那张牌：每色 100，合计 300', () => {
      expect(parseRealQuantity('每色 100，合计 300（黑 100 / 绿 100 / 白 100）')).toBe(300);
    });

    it('千分位逗号不许把 5,000 切成 5', () => {
      expect(parseRealQuantity('他要 5,000 pcs')).toBe(5000);
    });

    it('全段只出现一个数就是它', () => {
      expect(parseRealQuantity('他要 1000 个，正好够定制起订量')).toBe(1000);
      expect(parseRealQuantity('每款各要 30 个（他反复说 30 piece / each model 30 piece）')).toBe(30);
    });

    it('★ 多个数且没有合计标记 → 有歧义，不判 ★', () => {
      // 「他要 400 台，而 MOQ 是 1000」——400 和 1000 谁是他要的量，代码分不出来
      expect(parseRealQuantity('他要 400 台，而 MOQ 是 1000。能破例，但代价是单价停在 14')).toBeNull();
      expect(parseRealQuantity('他首单在 300 套与 600 套之间纠结，具体看价格定量')).toBeNull();
    });

    it('「首单是 N」把数说死了才认，「首单在 N 与 M 之间」不认', () => {
      expect(parseRealQuantity('他心里的首单是 100 pcs——不是只买 1 个样品，也不是大货柜')).toBe(100);
      expect(parseRealQuantity('后期口径抬到 5000 件，但首批就是 3000')).toBe(3000);
    });

    it('没有数字、空值一律 null，不许退化成 0', () => {
      expect(parseRealQuantity('他一直没说量——量要看价格和电机确认后才定')).toBeNull();
      expect(parseRealQuantity(undefined)).toBeNull();
      expect(parseRealQuantity('')).toBeNull();
    });
  });

  describe('readRealQuantity：只认数量牌，两张牌打架就不判', () => {
    const card = (value: string) => ({ value, unlock: '' });

    it('键名带 quantity / qty / 数量 的牌才读', () => {
      expect(readRealQuantity({ H1_real_quantity: card('合计 300') })).toBe(300);
      expect(readRealQuantity({ H3_real_qty: card('他要 200 个') })).toBe(200);
      // 键名跟数量无关的牌不许拿去当数量——这是老代码另一半误判的来源
      expect(readRealQuantity({ H2_delivery_deadline: card('11 月 15 日前必须到仓') })).toBeNull();
    });

    it('两张数量牌说的是同一个数 → 认；说的不是一个数 → 不判', () => {
      expect(readRealQuantity({ H1_qty_split: card('每种各 60，共 120'), H4_test_moq: card('这 120 套是测试小单') })).toBe(120);
      expect(readRealQuantity({ H1_qty: card('他要 100 个'), H2_order_qty: card('他要 500 个') })).toBeNull();
    });

    it('整份人设没有数量牌 → null（全库 152 份是这种）', () => {
      expect(readRealQuantity({ H1_he_is_comparing_three: card('他在比三家') })).toBeNull();
      expect(readRealQuantity(undefined)).toBeNull();
    });
  });
});

/**
 * ★ 「有效演习局」的第三条判据 ★（2026-08-28 王老师裁 D4 选项 A）
 *
 * 复盘五问从阻塞路径挪走之后，「出了分 ⇒ 复盘真做了」这条链断了，
 * 闸门会退回成「聊 6 轮 + 点评分」——正是漏洞台账 N-6 修掉的「三次敷衍」。
 * 这一组钉住替上去的那一条：本局至少解开一张暗牌，或至少开口问过一项六要素。
 *
 * 它必须挡得住敷衍、又不能冤枉「问了客户没给」的人——后者是 2026-08-19
 * 业务员当面喊过冤的地方，评分侧已经修过一次，这里不许再犯第二次。
 */
describe('★ 有效局第三条：这一局到底干活了没有 ★', () => {
  it('什么都没干 → 不算', () => {
    expect(didRealWork(emptyFacts())).toBe(false);
  });

  it('解开了一张暗牌 → 算', () => {
    const facts = emptyFacts();
    facts.unlockedCards.push({ key: 'H1_real_purpose', turn: 4 });
    expect(didRealWork(facts)).toBe(true);
  });

  it('★ 问了、客户没给 → 也算 ★ 判据是他开没开口，不是他拿没拿到', () => {
    const facts = emptyFacts();
    facts.elements.quantity = { status: 'asked_no_answer', collected: false, askedTurn: 3 };
    expect(didRealWork(facts)).toBe(true);
  });

  it('他问出来的六要素 → 算', () => {
    const facts = emptyFacts();
    facts.elements.quantity = { status: 'collected', collected: true, source: 'asked', turn: 5, askedTurn: 4 };
    expect(didRealWork(facts)).toBe(true);
  });

  it('★ 客户主动送上门的 → 不算 ★ 与洞察力那边同一条口径：不是他的功劳', () => {
    const facts = emptyFacts();
    facts.elements.quantity = { status: 'collected', collected: true, source: 'volunteered', turn: 2 };
    expect(didRealWork(facts)).toBe(false);
  });

  it('★ 跟进局前情已定的不算 ★ 否则跟进局开局就白送这道闸', () => {
    const facts = emptyFacts(['quantity', 'address', 'delivery_time']);
    expect(didRealWork(facts)).toBe(false);
  });

  it('facts 读不出来时按「没干活」处理，不抛', () => {
    expect(didRealWork(null)).toBe(false);
    expect(didRealWork(undefined)).toBe(false);
  });

  /** 老数据没有 askedTurn 这一列，退回「他问出来的」那一条，不能整段判成没干活 */
  it('老数据（没有 askedTurn / status）照样认得出来', () => {
    const facts = emptyFacts();
    facts.elements.quantity = { collected: true, source: 'asked', turn: 5 };
    expect(didRealWork(facts)).toBe(true);
  });
});

/** 轮内提示的取数口径。判定在 turn-decide，这里只验"数得对不对" */
describe('turnActivity：第 N 轮到底发生了什么', () => {
  it('这一轮解开的暗牌只数这一轮的', () => {
    const facts = emptyFacts();
    facts.unlockedCards.push({ key: 'H1', turn: 3 }, { key: 'H2', turn: 5 });
    expect(turnActivity(facts, 5).unlocked).toBe(1);
    expect(turnActivity(facts, 4).unlocked).toBe(0);
  });

  it('开口问过就算，客户答没答都算', () => {
    const facts = emptyFacts();
    facts.elements.quantity = { status: 'asked_no_answer', collected: false, askedTurn: 6 };
    expect(turnActivity(facts, 6).asked).toBe(1);
  });

  it('这一轮新拿到的六要素单独数', () => {
    const facts = emptyFacts();
    facts.elements.address = { status: 'collected', collected: true, source: 'asked', turn: 7, askedTurn: 6 };
    expect(turnActivity(facts, 7).collected).toBe(1);
    expect(turnActivity(facts, 6).asked).toBe(1);
  });

  /** 跟进局前情已定的那几项 turn 是 0，不能被当成"第 0 轮拿到的" */
  it('前情已定的不算新拿到', () => {
    const facts = emptyFacts(['quantity', 'address']);
    expect(turnActivity(facts, 0).collected).toBe(0);
  });

  it('报价与发目录都算动作轮', () => {
    const facts = emptyFacts();
    facts.deliverables = [{ turn: 4, kind: 'catalog' }];
    expect(turnActivity(facts, 4).formAction).toBe(true);
    expect(turnActivity(facts, 3).formAction).toBe(false);
  });

  it('facts 读不出来或轮次为 0 时全零，不抛', () => {
    expect(turnActivity(null, 3)).toEqual({ unlocked: 0, asked: 0, collected: 0, formAction: false });
    expect(turnActivity(emptyFacts(), 0).formAction).toBe(false);
  });
});
