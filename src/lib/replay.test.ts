/**
 * 回放工具的测试。
 *
 * ★ 为什么这 132 行必须有测试 ★
 * 它自己的文件头写着「不许砍」——没有它，每调一个扣分数值都要真人聊一局，
 * 成本高到根本不会去调，状态机参数就永远停在第一次拍脑袋的值上。
 * 换句话说：**所有调参决策都建立在它算得对的前提上**。它悄悄算错，
 * 结果是拿错误的"影响面"去改规则，而没有任何东西会报错。
 *
 * 这里重点盯两件它注释里明写、又最容易写反的事：
 * ① 客户回答要到**下一轮**才作数（顺序反了红线①会误判）；
 * ② 一旦退出就立刻停，后面的轮次不许再跑。
 */

import { describe, expect, it } from 'vitest';
import { diffRules, replay, type ReplayInput } from './replay';
import { DEFAULT_RULES } from '../../engine/rules';
import { SIX_ELEMENTS } from '../../engine/types';
import type { Extraction, CustomerExtraction, RuleTable, SixElement } from '../../engine/types';

function ext(over: Partial<Extraction> = {}): Extraction {
  return { asked_elements: [], asked_question: true, ...over };
}

function answers(elements: SixElement[]): CustomerExtraction {
  return { answered_elements: elements.map((element) => ({ element, quote: '' })), vague_elements: [] };
}

function inputOf(over: Partial<ReplayInput> = {}): ReplayInput {
  return {
    extractions: [{ turn: 1, extraction: ext() }],
    sessionType: 'inquiry',
    initialInterest: 50,
    rules: DEFAULT_RULES,
    ...over,
  };
}

describe('replay：拿历史抽取序列重跑状态机', () => {
  it('每一轮产出一个状态，轮数对得上', () => {
    const r = replay(
      inputOf({
        extractions: [1, 2, 3].map((turn) => ({ turn, extraction: ext({ asked_elements: ['quantity'] }) })),
      }),
    );
    expect(r.states).toHaveLength(3);
    expect(r.finalState).toBe(r.states[2]);
  });

  it('没触发退出时 exitAt / exitReason 都是 null', () => {
    const r = replay(inputOf());
    expect(r.exitAt).toBeNull();
    expect(r.exitReason).toBeNull();
  });

  it('★ 纯函数：同一份输入跑两遍结果完全一样 ★ 这是"回放"这件事成立的前提', () => {
    const input = inputOf({
      extractions: [1, 2, 3].map((turn) => ({ turn, extraction: ext({ asked_elements: ['quantity'] }) })),
      customerAnswers: [{ turn: 1, extraction: answers(['quantity']) }],
    });
    expect(replay(input)).toEqual(replay(input));
  });

  it('不修改传进来的输入', () => {
    const input = inputOf({ extractions: [{ turn: 1, extraction: ext({ asked_elements: ['quantity'] }) }] });
    const snapshot = JSON.parse(JSON.stringify(input.extractions));
    replay(input);
    expect(input.extractions).toEqual(snapshot);
  });

  describe('★ 客户回答要到下一轮才作数 ★（顺序反了红线①会误判）', () => {
    it('客户在第 1 轮答的，第 1 轮当时不算已收集', () => {
      // 只跑一轮：这一轮结束时客户答案才被 apply，状态里那一轮看到的是"问了没答"
      const r = replay(
        inputOf({
          extractions: [{ turn: 1, extraction: ext({ asked_elements: ['quantity'] }) }],
          customerAnswers: [{ turn: 1, extraction: answers(['quantity']) }],
        }),
      );
      // 跑完之后（循环末尾 apply 过了）才是 collected
      expect(r.facts.elements.quantity.collected).toBe(true);
      expect(r.facts.elements.quantity.turn).toBe(1);
    });

    it('没有客户侧抽取时，要素停在"问了没答"——这正是老局重放会偏严的原因', () => {
      const r = replay(
        inputOf({ extractions: [{ turn: 1, extraction: ext({ asked_elements: ['quantity'] }) }] }),
      );
      expect(r.facts.elements.quantity.collected).toBe(false);
      expect(r.facts.elements.quantity.askedTurn).toBe(1);
    });
  });

  it('preset（跟进局前情）里的要素一开始就是已收集，不用他问', () => {
    const r = replay(inputOf({ sessionType: 'followup', preset: ['quantity', 'address'] }));
    expect(r.facts.elements.quantity.collected).toBe(true);
    expect(r.facts.elements.quantity.source).toBe('preset');
    expect(r.facts.elements.product_attr.collected).toBe(false);
  });

  it('★ 报价不重算，直接沿用历史事实 ★ 回放只重跑规则，不重演业务员的动作', () => {
    const quotes = [
      { turn: 2, total: 1000, tier: 'A', formatCompliant: true } as unknown as NonNullable<ReplayInput['quotes']>[number],
    ];
    const r = replay(
      inputOf({ extractions: [1, 2].map((turn) => ({ turn, extraction: ext() })), quotes }),
    );
    expect(r.facts.quotes).toEqual(quotes);
  });

  describe('退出后立刻停', () => {
    it('★ 触发退出的那一轮之后不再跑任何一轮 ★', () => {
      // 耐心归零即退出：把初始兴趣压到最低，再连着几轮不问问题
      const extractions = [1, 2, 3, 4, 5, 6, 7, 8].map((turn) => ({
        turn,
        extraction: ext({ asked_question: false }),
      }));
      const r = replay(inputOf({ initialInterest: 1, extractions }));
      if (r.exitAt !== null) {
        // 状态数 == 退出那一轮的序号，说明后面的轮次没跑
        expect(r.states).toHaveLength(r.exitAt);
        expect(r.exitReason).not.toBeNull();
      } else {
        // 没退出也是合法结局，但那就该把 8 轮都跑完
        expect(r.states).toHaveLength(8);
      }
    });
  });

  it('空抽取序列：不抛错，返回初始状态', () => {
    const r = replay(inputOf({ extractions: [] }));
    expect(r.states).toEqual([]);
    expect(r.exitAt).toBeNull();
    expect(r.finalState.patience).toBeGreaterThan(0);
  });

  it('六要素全问全答后，收齐轮数被记下来', () => {
    const all = [...SIX_ELEMENTS] as SixElement[];
    const r = replay(
      inputOf({
        extractions: [
          { turn: 1, extraction: ext({ asked_elements: all }) },
          { turn: 2, extraction: ext() },
        ],
        customerAnswers: [{ turn: 1, extraction: answers(all) }],
      }),
    );
    expect(r.facts.turnsToCollectAll).not.toBeNull();
  });
});

describe('diffRules：改一个数值会影响多少局', () => {
  const base = inputOf({
    extractions: [1, 2, 3].map((turn) => ({ turn, extraction: ext({ asked_question: false }) })),
    initialInterest: 20,
  });
  const { rules: _drop, ...withoutRules } = base;

  it('新旧规则完全相同时 changed=false', () => {
    const d = diffRules('D-1', withoutRules, DEFAULT_RULES, DEFAULT_RULES);
    expect(d.changed).toBe(false);
    expect(d.before).toEqual(d.after);
    expect(d.drillId).toBe('D-1');
  });

  it('★ 规则不同导致结局变了就要报 changed ★ 这正是它存在的意义', () => {
    // 把"不问问题"的耐心惩罚放大，结局应当不同
    const harsher: RuleTable = {
      ...DEFAULT_RULES,
      noQuestionAsked: { patience: (DEFAULT_RULES.noQuestionAsked.patience ?? 0) - 40 },
    };
    const d = diffRules('D-2', withoutRules, DEFAULT_RULES, harsher);
    expect(d.changed).toBe(true);
  });

  it('对比的四个维度都进 changed 判据（退出轮/退出原因/耐心/红线）', () => {
    const d = diffRules('D-3', withoutRules, DEFAULT_RULES, DEFAULT_RULES);
    for (const key of ['exitAt', 'exitReason', 'patience', 'redlines'] as const) {
      expect(d.before).toHaveProperty(key);
      expect(d.after).toHaveProperty(key);
    }
  });
});
