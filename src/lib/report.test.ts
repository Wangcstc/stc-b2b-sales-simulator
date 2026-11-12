/**
 * 单局报告组装的测试。
 *
 * ★ 为什么一份"拼字符串"的模块值得认真测 ★
 * 报告是业务员唯一会逐字读的产物，也是主管复盘的依据。它错了不会抛异常、
 * 不会 500，只会**安静地写一句不对的话**——而看的人没有第二份材料可以对照。
 *
 * 更要紧的是：这个文件里几乎每一处分支都是**过去真出过事**才加上的，
 * 注释里写着日期和原因。所以这里的用例基本是一条 bug 一条：
 *   · 局型写死成「探需局」→ 9 个跟进局的报告全顶着错抬头（followup 字段）
 *   · 免责声明的判据看成了「有没有出题」→ 整局跳过时摆着五个「（未作答）」却不声明是推断（2026-08-22）
 *   · 报价数量一致性直接写「一致」→ 本局没有对照数量时那是假话（2026-08-24）
 *   · 六要素「问了没给」和「压根没问」混成一档 → 业务员搞不清下一局该改什么（2026-08-19）
 * 每条都配一个用例钉住，别再回去。
 */

import { describe, expect, it } from 'vitest';
import { assertNoLGrade, buildReport, type ReportInput } from './report';
import { emptyFacts, updateFacts, applyCustomerAnswers } from '../../engine/facts';
import type { SessionFacts, SessionScore, ScoreOutput, SixElement, Extraction } from '../../engine/types';
import type { ScoreLlmOutput } from './llm/score';

// ───────────────────────── 夹具 ─────────────────────────

function ext(over: Partial<Extraction> = {}): Extraction {
  return { asked_elements: [], asked_question: true, ...over };
}

/** 他问了这几项，客户在同一轮答了 */
function askedAndAnswered(f: SessionFacts, elements: SixElement[], turn = 1): SessionFacts {
  const next = updateFacts(f, ext({ asked_elements: elements }), turn);
  return applyCustomerAnswers(
    next,
    { answered_elements: elements.map((element) => ({ element, quote: '' })), vague_elements: [] },
    turn,
  );
}

const LLM: ScoreLlmOutput = {
  forces: {},
  progress: 1,
  answer_quality: 1,
  segments: [],
  unveil: [],
  one_action: '下一局先把数量问死再报价',
};

const VERIFIED: ScoreOutput = {
  insight: { score: 3, evidence: [{ turn: 2, quote: 'What is your target quantity?' }], anchor: '锚点A', next_action: '动作A' },
};

const PRECISE: SessionScore = {
  precise: true,
  coverage: 1,
  evaluableCount: 7,
  rawScore: 68,
  tier: 'D4',
  flags: [],
};

function inputOf(over: Partial<ReportInput> = {}): ReportInput {
  return {
    drillId: 'D-AB-001',
    turn: 8,
    difficulty: 'standard',
    followup: false,
    exitReason: null,
    facts: emptyFacts(),
    llm: LLM,
    score: PRECISE,
    verified: VERIFIED,
    ...over,
  };
}

// ───────────────────────── 用例 ─────────────────────────

describe('assertNoLGrade：报告里不许出现等级表述（需求 1.3 铁律）', () => {
  it('干净文案放行', () => {
    expect(() => assertNoLGrade('# 演习报告　演习段位 D4')).not.toThrow();
  });

  it('L1–L5 与「能力段位」一律抛错', () => {
    expect(() => assertNoLGrade('他已经是 L3 了')).toThrow(/禁用的等级表述/);
    expect(() => assertNoLGrade('能力段位很高')).toThrow(/禁用的等级表述/);
  });

  it('不误伤 FCL / LCL / D4 这类正常写法', () => {
    expect(() => assertNoLGrade('走 LCL 拼箱，演习段位 D4')).not.toThrow();
  });
});

describe('buildReport：七节结构', () => {
  it('七个小节的抬头都在，顺序不乱', () => {
    const md = buildReport(inputOf());
    const heads = ['一、你的答案盘点', '二、本局结论', '三、客观事实表', '四、七力评分与证据链', '五、逐段点评', '六、掀开客户暗牌', '七、这一局只练一个动作'];
    let cursor = -1;
    for (const h of heads) {
      const at = md.indexOf(`## ${h}`);
      expect(at, `缺小节：${h}`).toBeGreaterThan(-1);
      expect(at, `小节顺序不对：${h}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('★ 标题按局型写，不能写死「探需局」★ 这条错过一次：9 个跟进局全顶着探需局的抬头', () => {
    expect(buildReport(inputOf({ followup: false }))).toContain('# 演习报告：D-AB-001 · 探需局');
    expect(buildReport(inputOf({ followup: true }))).toContain('# 演习报告：D-AB-001 · 跟进局');
  });

  it('产出通过自身的 L 字检查（buildReport 末尾会自断言）', () => {
    expect(() => buildReport(inputOf())).not.toThrow();
  });
});

describe('★ 免责声明看的是「有没有答」，不是「有没有出题」★（2026-08-22 修）', () => {
  const DECLAIM = '因未作答复盘问答，以下判断为系统推断。';

  it('压根没出题 → 声明要出现', () => {
    expect(buildReport(inputOf({ coachQa: undefined }))).toContain(DECLAIM);
    expect(buildReport(inputOf({ coachQa: [] }))).toContain(DECLAIM);
  });

  it('★ 出了题但一道没答（整局跳过）→ 声明照样要出现 ★ 这正是当初漏掉的那一支', () => {
    const md = buildReport(inputOf({ coachQa: [{ question: 'Q1？', answer: null }, { question: 'Q2？', answer: '  ' }] }));
    expect(md).toContain(DECLAIM);
    // 题目本身还是要摆出来
    expect(md).toContain('（未作答）');
  });

  it('答了至少一道 → 不出现声明', () => {
    const md = buildReport(inputOf({ coachQa: [{ question: 'Q1？', answer: '我当时忘了问数量' }] }));
    expect(md).not.toContain(DECLAIM);
    expect(md).toContain('我当时忘了问数量');
  });
});

describe('二、本局结论', () => {
  it('精确分：摆段位、局分、结局、轮数，并附不可用于晋升的声明', () => {
    const md = buildReport(inputOf());
    expect(md).toContain('**D4（进阶期）**');
    expect(md).toContain('| 本局局分 | **68** |');
    expect(md).toContain('| 总轮数 | 8 |');
    expect(md).toContain('不得用于晋升、淘汰或公开排名');
  });

  it('★ 证据不足时不给精确分，并说明原因 ★「样本不足时给个精确分，比不给更有害」', () => {
    const md = buildReport(
      inputOf({ score: { precise: false, reason: '可评维度不足 3 项', coverage: 0.2, evaluableCount: 1, flags: [] } }),
    );
    expect(md).toContain('**本局证据不足以给出精确局分。**');
    expect(md).toContain('可评维度不足 3 项');
    expect(md).not.toContain('| 本局局分 |');
  });

  it('★ 难度系数 ≠1 时必须写出折算过程 ★ 只显示结果，业务员会以为评分乱跳', () => {
    const md = buildReport(
      inputOf({ score: { ...PRECISE, difficultyFactor: 1.2, baselineScore: 57, rawScore: 68 } }),
    );
    expect(md).toContain('| 难度系数 | 1.2 —— 原始 57 分按系数折算为 **68** 分 |');
  });

  it('★ 系数为 1（绝大多数情况）不出现这一行 ★ 不给报告添噪音', () => {
    const md = buildReport(inputOf({ score: { ...PRECISE, difficultyFactor: 1, baselineScore: 68 } }));
    expect(md).not.toContain('难度系数');
  });

  it('难度写中文名', () => {
    expect(buildReport(inputOf({ difficulty: 'hard' }))).toContain('| 难度 | 困难 |');
    expect(buildReport(inputOf({ difficulty: 'simple_with_distractors' }))).toContain('| 难度 | 简单 + 干扰项 |');
  });

  it('没作答复盘时「复盘作答质量」写「未作答」而不是 0', () => {
    const md = buildReport(inputOf({ llm: { ...LLM, answer_quality: undefined } }));
    expect(md).toContain('| 复盘作答质量 | 未作答 |');
  });

  describe('结局文案', () => {
    it('耐心归零 / 停滞 → 客户 ghost（判负）', () => {
      expect(buildReport(inputOf({ exitReason: 'patienceZero' }))).toContain('客户 ghost（判负）');
      expect(buildReport(inputOf({ exitReason: 'stagnant' }))).toContain('客户 ghost（判负）');
    });

    it('超轮数 → 客户已选其他供应商', () => {
      expect(buildReport(inputOf({ exitReason: 'maxTurns' }))).toContain('超轮数，客户已选其他供应商');
    });

    it('正常结束时按有没有报价分两种说法', () => {
      expect(buildReport(inputOf())).toContain('未报价即结束');
    });
  });
});

describe('三、客观事实表', () => {
  it('★ 「你问出来的」「客户主动给的」「问了客户没给」必须分三档 ★（2026-08-19 反馈）', () => {
    let f = emptyFacts();
    // 问了 quantity 且客户答了 → 你问出来的
    f = askedAndAnswered(f, ['quantity'], 1);
    // 问了 address，客户没答 → 问了没给
    f = updateFacts(f, ext({ asked_elements: ['address'] }), 2);

    const md = buildReport(inputOf({ facts: f }));
    expect(md).toContain('| 六要素·你问出来的 | **1/6**　数量 |');
    expect(md).toContain('六要素·你问了客户没给 | 1　地址/条款（第2轮问的）');
  });

  it('客户答得含糊时要标出来', () => {
    let f = emptyFacts();
    f = updateFacts(f, ext({ asked_elements: ['quantity'] }), 1);
    f = applyCustomerAnswers(f, { answered_elements: [], vague_elements: ['quantity'] }, 1);
    expect(buildReport(inputOf({ facts: f }))).toContain('客户答得含糊');
  });

  it('三档都为空时各写「无」，不留空格子', () => {
    const md = buildReport(inputOf());
    expect(md).toContain('| 六要素·你问出来的 | **0/6**　无 |');
    expect(md).toContain('| 已投递资料 | 无 |');
    expect(md).toContain('| 红线触发 | 无 |');
  });

  it('没收齐时写「未收齐」而不是空', () => {
    expect(buildReport(inputOf())).toContain('| 收齐轮数 | 未收齐 |');
  });

  it('红线触发要加粗——它是这份报告里最该被看见的一行', () => {
    const f = { ...emptyFacts(), redlines: ['R1', 'R4'] } as SessionFacts;
    expect(buildReport(inputOf({ facts: f }))).toContain('| 红线触发 | **R1、R4** |');
  });
});

describe('三、报价记录', () => {
  const quote = (over: Record<string, unknown> = {}) =>
    ({
      turn: 5,
      total: 1200,
      tier: 'A',
      formatCompliant: true,
      tradeTerms: 'FOB',
      leadTimeDays: 30,
      lines: [{ product: 'Widget', unitPrice: 12, quantity: 100 }],
      quantityMismatch: false,
      quantityChecked: true,
      ...over,
    }) as unknown as SessionFacts['quotes'][number];

  function withQuote(over: Record<string, unknown> = {}) {
    const f = { ...emptyFacts(), quotes: [quote(over)] } as SessionFacts;
    return buildReport(inputOf({ facts: f }));
  }

  it('没报价时整块不出现', () => {
    expect(buildReport(inputOf())).not.toContain('**报价记录**');
  });

  it('★ 逐个产品列出来 ★ 只给总额的话，多产品报价在复盘里看不出哪个价对应哪个货', () => {
    const md = withQuote();
    expect(md).toContain('**报价记录**');
    expect(md).toContain('Widget');
    expect(md).toContain('USD 12 × 100');
  });

  it('格式不合规要加粗', () => {
    expect(withQuote({ formatCompliant: false })).toContain('**不合规**');
  });

  it('贸易术语/交期没填时写「未填」，不写空', () => {
    const md = withQuote({ tradeTerms: '', leadTimeDays: null });
    expect(md).toContain('未填');
  });

  describe('★ 数量一致性四态，「一致」得是真比过才敢说 ★（2026-08-24）', () => {
    it('数量当时还没确认过就报了', () => {
      expect(withQuote({ quantityMismatch: true, quantityConfirmed: false })).toContain(
        '**数量当时还没确认过就报了**',
      );
    });

    it('与客户给的数量对不上', () => {
      expect(withQuote({ quantityMismatch: true, quantityConfirmed: true })).toContain('**与客户给的数量对不上**');
    });

    it('★ 本局没有可对照的真实数量 → 写「本局无对照数量」，不许写「一致」★ 那是另一种假话', () => {
      const md = withQuote({ quantityMismatch: false, quantityChecked: false });
      expect(md).toContain('本局无对照数量');
      expect(md).not.toContain('| 一致 |');
    });

    it('真比过且对得上 → 才写「一致」', () => {
      expect(withQuote({ quantityMismatch: false, quantityChecked: true })).toContain('一致');
    });
  });
});

describe('四、七力评分与证据链', () => {
  it('有证据时逐条列出轮次与原话', () => {
    const md = buildReport(inputOf());
    expect(md).toContain('### 洞察力');
    expect(md).toContain('- 第 2 轮：「What is your target quantity?」');
    expect(md).toContain('**锚点**：锚点A');
    expect(md).toContain('**下一步**：动作A');
  });

  it('★ 没有证据时要明说「不计入分母」★ 而不是留白让人以为是 0 分', () => {
    const md = buildReport(
      inputOf({ verified: { insight: { score: 'INSUFFICIENT', evidence: [], anchor: 'a', next_action: 'b' } } }),
    );
    expect(md).toContain('（证据不足，不计入分母）');
    expect(md).toContain('**证据**：无（该维度未计入分母）');
  });

  it('NA 维度写「本局不适用」', () => {
    const md = buildReport(
      inputOf({ verified: { negotiation: { score: 'NA', evidence: [], anchor: 'a', next_action: 'b' } } }),
    );
    expect(md).toContain('（本局不适用）');
  });

  it('没给分的维度整段不出现', () => {
    const md = buildReport(inputOf({ verified: {} }));
    expect(md).not.toContain('### 洞察力');
  });
});

describe('五、六节：点评与暗牌', () => {
  it('逐段点评把中英两版改写都摆出来', () => {
    const md = buildReport(
      inputOf({
        llm: {
          ...LLM,
          segments: [
            {
              turn: 3,
              quote: 'Our price is 12 USD.',
              problem: '数量没确认就报价',
              coach_comment: '先问死数量',
              better_reply_cn: '请问您这次大概要多少？',
              better_reply_en: 'May I know your target quantity?',
            },
          ],
        },
      }),
    );
    expect(md).toContain('### 第 3 轮');
    expect(md).toContain('- 中文：请问您这次大概要多少？');
    expect(md).toContain('- English：May I know your target quantity?');
  });

  it('暗牌：错过的写在第几轮错过，没触及的写「本局未触及」', () => {
    const md = buildReport(
      inputOf({
        llm: {
          ...LLM,
          unveil: [
            { card: '真实预算', what_it_was: '偏低', missed_at_turn: 4, how_to_get_it: '问一句预算区间' },
            { card: '决策人', what_it_was: '不是他', missed_at_turn: null, how_to_get_it: '问谁拍板' },
          ],
        },
      }),
    );
    expect(md).toContain('你在第 4 轮错过了它');
    expect(md).toContain('本局未触及');
  });

  it('第七节永远只给一个动作', () => {
    expect(buildReport(inputOf())).toContain('**下一局先把数量问死再报价**');
  });
});
