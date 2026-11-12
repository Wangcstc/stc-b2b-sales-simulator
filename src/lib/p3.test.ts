/**
 * P3 阶段单元测试：考试选题 / 回放工具 / 报告组装
 *
 * ★ 原来第一组是「考试闸门」（v2.0 的 judgeExam）★ 2026-08-24 删。
 * 那套判定（3 局中位数 ≥45 ＋洞察≥3 ＋无红线 ＋复盘≥1）从 v1.1 起就不再
 * 决定任何人的资格，库里也没有一条走它的记录。现在的判定锁在
 * `admission-v11.test.ts`（含红线三分流与待复核）。
 */

import { describe, it, expect } from 'vitest';
import { median, assertConclusionClean, pickExamVariants } from './exam';
import { replay, diffRules } from './replay';
import { stripAnswers } from './bg-package';
import { buildReport } from './report';
import { emptyFacts } from '../../engine/facts';
import { DEFAULT_RULES } from '../../engine/rules';
import type { Extraction } from '../../engine/types';

// ──────────────────────── 判定共用的小工具 ────────────────────────

describe('中位数', () => {
  it('3 局用中位数不用平均', () => {
    expect(median([40, 46, 90])).toBe(46); // 平均是 58.7，中位数才 46
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('结论文案守卫', () => {
  it('★不许出现任何等级表述★', () => {
    expect(() => assertConclusionClean('已获得询盘接待准入资格')).not.toThrow();
    expect(() => assertConclusionClean('恭喜达到 L2 水平')).toThrow();
    expect(() => assertConclusionClean('七力评级 L3')).toThrow();
    expect(() => assertConclusionClean('你的能力段位已更新')).toThrow();
  });
});

// ───────────────────────── 考试选题 ─────────────────────────

describe('考试选题', () => {
  const v = (id: string, sessionType: 'INQUIRY' | 'FOLLOWUP', difficulty: string) => ({ id, sessionType, difficulty });
  const fullPool = [
    v('inq-std-a', 'INQUIRY', 'standard'),
    v('inq-std-b', 'INQUIRY', 'standard'),
    v('inq-hard-a', 'INQUIRY', 'hard'),
    v('inq-hard-b', 'INQUIRY', 'hard'),
    v('fup-a', 'FOLLOWUP', 'standard'),
    v('fup-b', 'FOLLOWUP', 'standard'),
  ];

  it('三个槽位各取其类：探需·标准 + 探需·困难 + 跟进', () => {
    const { picked, shortfalls } = pickExamVariants(fullPool, () => 0);
    expect(picked.map((p) => p.id)).toEqual(['inq-std-a', 'inq-hard-a', 'fup-a']);
    expect(shortfalls).toEqual([]);
  });

  it('★ 难度受控 ★ 池子里探需标准局更多，也不许两局都是标准局', () => {
    const pool = [
      v('inq-std-a', 'INQUIRY', 'standard'),
      v('inq-std-b', 'INQUIRY', 'standard'),
      v('inq-std-c', 'INQUIRY', 'standard'),
      v('inq-hard-a', 'INQUIRY', 'hard'),
      v('fup-a', 'FOLLOWUP', 'standard'),
    ];
    const { picked } = pickExamVariants(pool, () => 0);
    expect(picked.filter((p) => p.difficulty === 'hard')).toHaveLength(1);
  });

  it('★ 可轮换 ★ 随机源不同就选出不同的题（否则第一个考完就能透题）', () => {
    const first = pickExamVariants(fullPool, () => 0).picked.map((p) => p.id);
    const second = pickExamVariants(fullPool, () => 0.99).picked.map((p) => p.id);
    expect(second).not.toEqual(first);
    expect(second).toEqual(['inq-std-b', 'inq-hard-b', 'fup-b']);
  });

  it('同一场考试不会重复抽到同一个变体', () => {
    const pool = [v('only-inq', 'INQUIRY', 'standard'), v('fup-a', 'FOLLOWUP', 'standard')];
    const { picked } = pickExamVariants(pool, () => 0);
    expect(new Set(picked.map((p) => p.id)).size).toBe(picked.length);
  });

  it('缺困难探需局时降级顶上，但必须说出来（不许假装齐了）', () => {
    const pool = [
      v('inq-std-a', 'INQUIRY', 'standard'),
      v('inq-std-b', 'INQUIRY', 'standard'),
      v('fup-a', 'FOLLOWUP', 'standard'),
    ];
    const { picked, shortfalls } = pickExamVariants(pool, () => 0);
    expect(picked).toHaveLength(3);
    expect(shortfalls.join()).toContain('没有困难探需局');
  });

  it('缺跟进局时降级顶上，同样要说出来', () => {
    const pool = [v('inq-std-a', 'INQUIRY', 'standard'), v('inq-hard-a', 'INQUIRY', 'hard'), v('inq-std-b', 'INQUIRY', 'standard')];
    const { picked, shortfalls } = pickExamVariants(pool, () => 0);
    expect(picked).toHaveLength(3);
    expect(shortfalls.join()).toContain('没有跟进局');
  });
});

// ───────────────────────── 背调包剥壳 ─────────────────────────

describe('背调包剥壳（答案不许随响应发出去）', () => {
  const pkg = {
    title: 'AI 客户背景调查报告',
    content: '该公司为大型进口分销商……',
    planted_error: { type: 'scale_inflated', truth: '其实是个小卖家', detectable_via: ['x'] },
    _planted_error_design: '这里写的是出题思路',
    website: {
      url: 'www.example.com',
      categories: ['Housewares'],
      _snapshot_note: '新人要自己发现这是个空壳站',
      _cross_check_hint: '域名注册时间对不上',
    },
    social: {
      linkedin: { handle: 'X Ltd.', employees_listed: 2, _cross_check_hint: '2 人 vs 自有仓储' },
    },
  };

  it('★ planted_error 整块必须消失 ★ 它写着预埋错误的真相', () => {
    const out = stripAnswers(pkg) as Record<string, unknown>;
    expect(out.planted_error).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('其实是个小卖家');
  });

  it('下划线开头的设计注释一律不出服务端（含嵌套层）', () => {
    const json = JSON.stringify(stripAnswers(pkg));
    expect(json).not.toContain('出题思路');
    expect(json).not.toContain('空壳站');
    expect(json).not.toContain('域名注册时间对不上');
    expect(json).not.toContain('2 人 vs 自有仓储');
  });

  it('给新人看的材料一个都不能丢——剥壳不是删干净', () => {
    const out = stripAnswers(pkg) as typeof pkg;
    expect(out.title).toBe('AI 客户背景调查报告');
    expect(out.content).toContain('大型进口分销商');
    expect(out.website.url).toBe('www.example.com');
    expect(out.website.categories).toEqual(['Housewares']);
    // 这一条是识破路径本身，必须留下
    expect(out.social.linkedin.employees_listed).toBe(2);
  });

  it('不改原对象（Prisma 查出来的 JSON 别人还要用）', () => {
    stripAnswers(pkg);
    expect(pkg.planted_error.truth).toBe('其实是个小卖家');
  });

  /**
   * ★ 2026-08-28 修的一个真漏 ★
   *
   * 剥壳层原来只认**精确的单数** `planted_error`。而 P12-EX-001 / P12-EX-002 两份
   * 背调包写的是复数 `planted_errors`，同层还有 `scoring_hooks` / `card_hooks`——
   * 三个键全部躲过剥壳，**从 2026-08-13 加进库那天起一直发给浏览器**：
   * 哪两张牌是预埋错误、怎样算「识破」、识破与否各怎么算分，F12 一开全在。
   * 那是 2026-08-08 事故的原样重演，只是换了个键名。
   *
   * 教训：一个靠**精确匹配一个名字**的安全阀，挡的只是当初那一次。
   * 下面这几条钉住前缀匹配——加复数、加后缀、拆成两块，都不许再漏出去。
   */
  describe('★ 换个写法就绕过去 ★ 剥壳按前缀匹配，不是精确匹配', () => {
    const alt = {
      conclusion: '给新人看的结论',
      findings: ['给新人看的发现'],
      planted_errors: { ids: ['BG7'], detected_definition: '说出至少一条不一致项才算识破' },
      scoring_hooks: { insight_5: '识破了给 5 分' },
      card_hooks: { BG7: '对应 H3' },
    };

    it('复数 planted_errors 也必须消失', () => {
      const json = JSON.stringify(stripAnswers(alt));
      expect(json).not.toContain('BG7');
      expect(json).not.toContain('才算识破');
    });

    it('scoring_hooks / card_hooks 也必须消失', () => {
      const json = JSON.stringify(stripAnswers(alt));
      expect(json).not.toContain('识破了给 5 分');
      expect(json).not.toContain('对应 H3');
    });

    it('给新人看的内容照常留下', () => {
      const out = stripAnswers(alt) as typeof alt;
      expect(out.conclusion).toBe('给新人看的结论');
      expect(out.findings).toEqual(['给新人看的发现']);
    });
  });
});

// ───────────────────────── 回放工具 ─────────────────────────

describe('回放工具', () => {
  const ext = (o: Partial<Extraction> = {}): Extraction => ({ asked_elements: [], asked_question: true, ...o });

  const series = [
    { turn: 1, extraction: ext({ asked_elements: ['product_attr'] }) },
    { turn: 2, extraction: ext({ asked_elements: ['quantity'] }) },
    { turn: 3, extraction: ext({ asked_question: false }) },
    { turn: 4, extraction: ext({ asked_question: false }) },
    { turn: 5, extraction: ext({ asked_question: false }) },
  ];

  it('用历史抽取序列重跑，得到逐轮状态', () => {
    const r = replay({ extractions: series, sessionType: 'inquiry', initialInterest: 70, rules: DEFAULT_RULES });
    expect(r.states).toHaveLength(5);
    expect(r.finalState.turn).toBe(5);
  });

  it('连续 3 轮无新信息 → 回放里也会离场', () => {
    const r = replay({ extractions: series, sessionType: 'inquiry', initialInterest: 70, rules: DEFAULT_RULES });
    expect(r.exitReason).toBe('stagnant');
    expect(r.exitAt).toBe(5);
  });

  it('★改一个扣分数值，能看出有多少局结局变了★', () => {
    const harsher = {
      ...DEFAULT_RULES,
      noQuestionAsked: { patience: -40 }, // 从 −10 调到 −40
    };
    const d = diffRules('D-TEST-01', { extractions: series, sessionType: 'inquiry', initialInterest: 70 }, DEFAULT_RULES, harsher);
    expect(d.changed).toBe(true);
    expect(d.after.patience).toBeLessThan(d.before.patience);
  });

  it('规则没变时结局也不变（回放本身是确定性的）', () => {
    const d = diffRules('D-TEST-02', { extractions: series, sessionType: 'inquiry', initialInterest: 70 }, DEFAULT_RULES, DEFAULT_RULES);
    expect(d.changed).toBe(false);
  });

  it('回放会重算红线', () => {
    const withEmptyChase = [{ turn: 1, extraction: ext({ is_empty_chase: true }) }];
    const r = replay({
      extractions: withEmptyChase,
      sessionType: 'followup',
      initialInterest: 40,
      rules: DEFAULT_RULES,
    });
    expect(r.redlines).toContain('R3');
  });
});


// ───────────────────────── 报告：作答与未作答要分得开 ─────────────────────────

/**
 * ★ 锁的是「免责声明看的是有没有答，不是有没有出过题」★（2026-08-22）
 *
 * 整局跳过之后题目还在库里（`coachQa.length > 0`），原来的判据会认为「他答过了」，
 * 于是报告里摆着五个「（未作答）」，却不再声明这份诊断是系统推断出来的。
 * 评分接口那边同形的判据（作答质量该不该有值）也一起改了，
 * 但那一段要连库，锁不住——这里锁住报告这一半。
 */
describe('报告：作答与未作答', () => {
  const base = {
    drillId: 'D-TEST-P1-20260822-01',
    turn: 8,
    difficulty: 'standard',
    followup: false,
    exitReason: null,
    facts: emptyFacts(),
    llm: {
      forces: {},
      progress: 1 as const,
      segments: [],
      unveil: [],
      one_action: '先把数量确认了再报价',
    },
    score: { precise: false as const, reason: '样本不足', coverage: 0.2, evaluableCount: 1, flags: [] },
    verified: {},
  };

  const DISCLAIMER = '因未作答复盘问答，以下判断为系统推断';

  it('压根没出过题：给免责声明', () => {
    expect(buildReport({ ...base, coachQa: [] })).toContain(DISCLAIMER);
  });

  it('出了题但一题没答（整局跳过）：**同样**要给免责声明', () => {
    const md = buildReport({
      ...base,
      coachQa: [
        { question: '你第 6 轮为什么直接报价？', answer: null },
        { question: '这一局最大的阻力是什么？', answer: null },
      ],
    });
    expect(md).toContain(DISCLAIMER);
    // 题目本身仍要摆出来——主管要看得见他是被问了什么却没答
    expect(md).toContain('你第 6 轮为什么直接报价？');
  });

  it('答了空白字符不算答', () => {
    const md = buildReport({ ...base, coachQa: [{ question: 'Q', answer: '   ' }] });
    expect(md).toContain(DISCLAIMER);
  });

  it('真答了：不给免责声明', () => {
    const md = buildReport({
      ...base,
      coachQa: [{ question: '你第 6 轮为什么直接报价？', answer: '他催得急，我怕他跑了' }],
    });
    expect(md).not.toContain(DISCLAIMER);
    expect(md).toContain('他催得急，我怕他跑了');
  });
});
