/**
 * 交付动作在【引擎之外】那两层的回归（2026-08-19 反馈 #4）
 *
 * ★ 为什么单独一个文件 ★ 这两条断言要 import `llm/roleplay` 与 `llm/score`，
 * 而 `engine/` 是无菌区、不许反向 import `llm/`——engine.test.ts 跟着这条规矩走，
 * 所以放不进去。事实表与规则那几条仍在 `engine/engine.test.ts` 里。
 *
 * ★ 这两层才是这条反馈真正的痛处 ★ 事实表记没记下来业务员看不见；
 * 他看得见的是「客户还在一轮轮要目录」和「点评说我拖着不给」——
 * 一个在客户 prompt 里，一个在评分证据块里。这里钉死的就是这两处。
 */

import { describe, it, expect } from 'vitest';
import { emptyFacts, submitDeliverable } from '../../engine/facts';
import { initialState, decideDirective } from '../../engine/state-machine';
import { emptyUnlockState } from '../../engine/unlock';
import { buildSegment2, type PersonaConfig } from './llm/roleplay';
import { renderFacts } from './llm/score';

const PERSONA: PersonaConfig = {
  openCard: { inquiry_text: 'We need 3-color tumblers.', name: 'Test Buyer' },
  product: { name: 'Tumbler', model: 'CUP-350' },
  hiddenCard: {
    H1: { value: '每色 100，合计 300', unlock: '追问口径', unlock_patterns: ['total'], leak_signals: ['300 total'] },
  },
  languageStyle: '简短直接',
};

const seg2 = (delivered: 'catalog'[] = []) =>
  buildSegment2(PERSONA, emptyUnlockState(), decideDirective(initialState(70)), undefined, delivered);

describe('★ 发目录之后客户不许再要 ★（2026-08-19 反馈 #4）', () => {
  it('发过目录 → 客户 prompt 里明写已收到，并禁止再索要', () => {
    const s = seg2(['catalog']);
    expect(s).toContain('已经发给你、你已经收到的资料');
    expect(s).toContain('产品目录');
    expect(s).toContain('不许再向对方索要');
  });

  it('★ 没发过就一个字都不许提 ★ 否则等于白送他一份根本没发的资料', () => {
    const s = seg2([]);
    expect(s).not.toContain('已经收到的资料');
    expect(s).not.toContain('Product_Catalog');
  });

  it('收到资料不等于客户就满意了——他仍可以挑刺', () => {
    expect(seg2(['catalog'])).toContain('收到资料不等于你就满意了');
  });

  it('段 1 那段可缓存前缀不受影响：交付信息只进段 2', () => {
    // 段 2 变了不影响段 1 的逐字节稳定性，这是 prompt 缓存命中的前提
    expect(seg2(['catalog'])).not.toContain('第一铁律');
  });
});

describe('★ 评分证据块要说清资料确已送达 ★', () => {
  it('发过 → 写明已送达，并禁止再判"拖着不给"', () => {
    const s = renderFacts(submitDeliverable(emptyFacts(), 'catalog', 2));
    expect(s).toContain('第2轮：产品目录');
    expect(s).toContain('确已送达客户');
    expect(s).toContain('不许再判他');
  });

  it('没发过 → 如实写没发过（不能因为加了这一段就变成默认发过）', () => {
    const s = renderFacts(emptyFacts());
    expect(s).toContain('本局没有投递过任何资料');
    expect(s).not.toContain('确已送达客户');
  });

  it('★ 发了不等于免罪 ★ 证据块仍要求评"发得是不是时候"', () => {
    const s = renderFacts(submitDeliverable(emptyFacts(), 'catalog', 1));
    expect(s).toContain('需求还没问清就先甩资料是减分的');
  });
});
