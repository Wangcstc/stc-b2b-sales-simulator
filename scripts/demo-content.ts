/**
 * 演示数据的「文案」部分：一段连贯的对话、七力的点评、完整的报告正文。
 *
 * ★ 为什么单独成文件 ★ seed-demo.ts 管「造哪些行、怎么清干净」，这里管「行里写什么字」。
 * 两件事分开，改文案不会碰到清单与清理的逻辑。
 *
 * ★ 报告正文不手写，走真的 buildReport ★ 真系统怎么拼七节报告，演示就怎么拼，
 * 将来报告改版，演示数据跟着变，不会出现「演示的报告长得和真的不一样」。
 *
 * ★ 对话与产品、国别无关 ★ 演示局会抽到各种人设（露营椅、不同国家的客户），
 * 所以台词里不写具体品类和国家，只写「the item」「our market」，放到哪个人设下都不穿帮。
 *
 * ★ 不出现任何真实客户的信息 ★ 这是公开仓库里的文件，脱敏门禁会扫它。
 */
import type { Force, ForceResult, QuoteRecord, ScoreOutput, SessionFacts, SessionScore } from '../engine/types';
import { FORCES } from '../engine/types';
import type { ScoreLlmOutput, SegmentComment, UnveilItem } from '../src/lib/llm/score';
import { buildReport } from '../src/lib/report';

/* ───────────── 一段连贯的 18 轮对话 ───────────── */

interface Line {
  en: string;
  /** 这一句有问题时的点评（只有部分句子有） */
  review?: { problem: string; coach: string; betterCn: string; betterEn: string };
}

export const TRAINEE_SCRIPT: Line[] = [
  { en: 'Hi, thank you for your inquiry! To quote accurately, may I confirm the quantity you plan for the first order?' },
  {
    en: 'Great. Could you tell me which model and size you prefer, and any special requirement for the material?',
    review: {
      problem: '一句话同时问了型号、尺寸、材料三件事，客户只会挑最容易回答的那个。',
      coach: '一次只问一个问题，问完等他答。客户答了再顺着往下追，比一口气抛三个有效得多。',
      betterCn: '先问规格：您更倾向哪个型号？拿到答案再问材料和尺寸。',
      betterEn: 'Which model are you leaning towards? Once I know that, I can check the size and material options for you.',
    },
  },
  { en: 'No problem, we support OEM logo printing. Is it a one-color or a full-color print?' },
  { en: 'Our MOQ for custom packaging is {moq}pcs. May I know your destination port, so I can quote the right terms?' },
  {
    en: 'Got it. When do you need the goods to arrive?',
    review: {
      problem: '客户刚说了要在旺季前上架，你只问了「什么时候到」，没有追问他的销售计划。',
      coach: '交期背后是客户的销售节奏。问清楚他哪天开卖、能接受晚几天，你才知道交期能不能当谈判筹码。',
      betterCn: '先确认他的上架时间，再问能不能分批到货。',
      betterEn: 'When do you plan to start selling? If you can accept two shipments, I can arrange the first one earlier.',
    },
  },
  { en: 'Understood. Do you have any certificate requirement for your market, for example a safety or quality report?' },
  { en: 'Sure, I will send you the test report together with our catalog today.' },
  {
    en: 'For {qty}pcs the price is USD {price} per piece, {term}, lead time {lead} days.',
    review: {
      problem: '客户刚抛出对手价 {rival}，你没确认对方的规格和数量是否和你的一样，就直接报了价。',
      coach: '客户报对手价是在试探你。先弄清「他比的是不是同一个东西」，再决定报不报、怎么报，否则你的价格一出口就被拿去比较。',
      betterCn: '先确认对手价对应的规格、材料和数量是否一致，再给出对比后的报价。',
      betterEn:
        'Before I quote, may I confirm that the USD {rival} is for the same size, material and {qty}pcs? Then I can give you a fair comparison.',
    },
  },
  {
    en: 'Our quality is better, so I can give you a 3% discount.',
    review: {
      problem: '没有任何交换条件，就主动让价 3%。让出去的价格收不回来，客户还会继续压。',
      coach: '让价一定要换东西：更大的数量、固定的订货节奏、更快的付款。空手让价，等于告诉客户你的价格有水分。',
      betterCn: '把让价和数量挂钩：如果全年用量更大，可以谈更好的价格。',
      betterEn:
        'I can look at a better price if we talk about a larger quantity or a fixed schedule for the season. What volume are you planning for the whole year?',
    },
  },
  { en: 'May I know if {counter} is based on {qty}pcs, or would you consider a bigger quantity for the whole season?' },
  { en: 'That helps. For {seasonQty}pcs in two shipments I can offer USD {seasonPrice}, {term}. Is the second shipment in May?' },
  {
    en: 'Of course. May I send you a sample first, so you can confirm the quality yourself?',
    review: {
      problem: '客户说要和合伙人商量，你马上转去寄样，没有问清楚他们商量的顾虑是什么。',
      coach: '「我要商量一下」往往藏着一个没说出口的顾虑。先问一句，把顾虑翻出来，样品才能对症下药。',
      betterCn: '先问他和合伙人主要想确认哪一点，再提出针对性的样品方案。',
      betterEn:
        'Sure. Just so I can help you decide, what is the main point you would like to confirm with your partner: price, quality or timing?',
    },
  },
  { en: 'The sample is free for you, you only pay the courier cost. It takes 7 days to prepare.' },
  { en: 'I will send the PI today. Could you share your WhatsApp or email so I can follow up easily?' },
  { en: 'Perfect. I will follow up with the PI and the test report tomorrow morning.' },
  { en: 'Is there anything else I can help you with today?' },
  { en: 'Thanks for your time. I will update you as soon as the sample is shipped.' },
  { en: 'Thank you, have a nice day!' },
];

export const CUSTOMER_SCRIPT: string[] = [
  'Hi, we are a distributor selling to retail chains in our market. Around {qty}pcs for the first order.',
  'The standard size is fine, but we need our own logo on the packaging.',
  'One color is enough. What is your MOQ for custom packaging?',
  'Please quote {term}, the same as your price list.',
  'We plan to start selling in the high season, so I need the goods in our warehouse about a month before.',
  'Yes, the test report is a must for our buyers. Please send it to me.',
  'Thanks. By the way, what is your best price? My current supplier gives me USD {rival}.',
  'That is a bit high compared with my current supplier.',
  '3% is not enough. Can you do USD {counter}?',
  'If the quality is good, we may take {seasonQty}pcs for the season, in two shipments.',
  'May or June. Let me discuss with my partner and come back to you.',
  'Yes, please. How much is the sample and how long does it take?',
  'OK. Please send the PI for the sample.',
  'My email is on the inquiry. I will send you my WhatsApp later.',
  'Great, talk to you tomorrow.',
  'No, that is all for now.',
  'OK, thanks.',
  'You too.',
];

export function traineeLine(turn: number, c: DemoCtx): string {
  if (c.followup && turn <= FOLLOWUP_TRAINEE.length) return FOLLOWUP_TRAINEE[turn - 1]!;
  return fill(TRAINEE_SCRIPT[Math.min(turn, TRAINEE_SCRIPT.length) - 1]!.en, c);
}
export function customerLine(turn: number, c: DemoCtx): string {
  if (c.followup && turn <= FOLLOWUP_CUSTOMER.length) return fill(FOLLOWUP_CUSTOMER[turn - 1]!, c);
  return fill(CUSTOMER_SCRIPT[Math.min(turn, CUSTOMER_SCRIPT.length) - 1]!, c);
}


/* ───────────── 按人设填数字 ───────────── */

/**
 * 台词里的数量、价格、品名不写死，按这一局的人设填：
 * 右边的价目表是 USD 12.5，对话里却在报 USD 1.85，录屏一眼穿帮。
 * 数字全部来自人设自己的 `product`（价目表、起订量、交期）和 `openCard.inquiry_text`（客户自己说的数量）。
 */
export interface DemoCtx {
  qty: string;
  moq: string;
  price: string;
  rival: string;
  counter: string;
  seasonQty: string;
  seasonPrice: string;
  term: string;
  lead: string;
  /** 数值版，写事实表用 */
  priceNum: number;
  qtyNum: number;
  incoterm: string;
  followup: boolean;
}

interface Tier { min_qty: number; max_qty: number | null; unit_price: number; incoterm?: string; port?: string }

const fmtQty = (n: number) => n.toLocaleString('en-US');
const round2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export function demoCtx(variant: { product: unknown; openCard: unknown; persona: { sessionType: string } }): DemoCtx {
  const product = (variant.product ?? {}) as {
    moq?: { qty?: number };
    lead_time?: { bulk_days?: number };
    price_tiers?: Tier[];
  };
  const tiers = [...(product.price_tiers ?? [])].sort((x, y) => x.min_qty - y.min_qty);
  const moq = product.moq?.qty ?? 500;
  // 客户自己在询盘里说的数量优先；没说就取第二档的起点（比起订量大，有降价空间）
  const inquiry = String((variant.openCard as { inquiry_text?: string } | null)?.inquiry_text ?? '');
  const said = [...inquiry.matchAll(/(\d[\d,]{2,})\s*(?:pcs|pieces|piece|sets|chairs|pads|lanterns|units)?/gi)]
    .map((m) => Number(m[1]!.replace(/,/g, '')))
    .find((n) => n >= moq);
  const qtyNum = said ?? tiers[1]?.min_qty ?? moq * 2;
  const priceAt = (q: number) => [...tiers].reverse().find((t) => q >= t.min_qty)?.unit_price ?? tiers[0]?.unit_price ?? 5;
  const priceNum = priceAt(qtyNum);
  const seasonQtyNum = qtyNum * 2;
  const t0 = tiers[0];
  const incoterm = t0?.incoterm ?? 'FOB';
  return {
    qty: fmtQty(qtyNum),
    moq: fmtQty(moq),
    price: round2(priceNum),
    rival: round2(priceNum * 0.88),
    counter: round2(priceNum * 0.94),
    seasonQty: fmtQty(seasonQtyNum),
    seasonPrice: round2(priceAt(seasonQtyNum)),
    term: `${incoterm} ${t0?.port ?? 'Ningbo'}`,
    lead: String(product.lead_time?.bulk_days ?? 30),
    priceNum,
    qtyNum,
    incoterm,
    followup: variant.persona.sessionType === 'FOLLOWUP',
  };
}

const fill = (text: string, c: DemoCtx): string =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => (k in c ? String((c as unknown as Record<string, unknown>)[k]) : m));

/** 跟进局的开场：客户是之前报过价、没回音的那一位，不是第一次来询盘 */
const FOLLOWUP_TRAINEE = ['Hi, just following up on my earlier message. Have you had a chance to review it?', 'Understood. What is the main point holding you back: price, quality or timing?'];
const FOLLOWUP_CUSTOMER = ['Yes, we looked at it. We are still comparing a few suppliers for the {qty}pcs.', 'Mostly price. My current supplier gives me USD {rival}.'];

/* ───────────── 事实表里的报价与资料 ───────────── */

/** 打到第 8 轮以上的局，事实表里补一条报价（对应对话里第 8 轮报的 1.85）和一次发目录（第 7 轮） */
export function addDealFacts(facts: SessionFacts, turns: number, c: DemoCtx): void {
  if (turns >= 7) facts.deliverables = [{ turn: 7, kind: 'catalog' }];
  if (turns >= 8) {
    const q: QuoteRecord = {
      turn: 8,
      unitPrice: c.priceNum,
      quantity: c.qtyNum,
      freight: 0,
      total: Math.round(c.priceNum * c.qtyNum * 100) / 100,
      tradeTerms: c.incoterm,
      leadTimeDays: Number(c.lead),
      tier: 'B',
      hasQuoteSheet: true,
      hasScreenshot: false,
      formatCompliant: true,
      quantityMismatch: false,
      quantityChecked: false,
    };
    facts.quotes = [q];
  }
}

/* ───────────── 复盘问答 ───────────── */

export const COACH_QA: { question: string; answer: string }[] = [
  {
    question: '客户这次询盘，真正想解决的问题是什么？',
    answer: '他是经销商，要给零售客户供货，看重的是交期和能不能贴自己的品牌，价格是第二位的。',
  },
  {
    question: '客户报出对手价格时，你当时是怎么想的？',
    answer: '我有点慌，怕丢单，所以马上给了一个价格，现在想想应该先问他对手的规格。',
  },
  {
    question: '如果重来一次，下一轮你会先问什么？',
    answer: '先问他的全年用量和上架时间，再决定怎么报价。',
  },
];

/* ───────────── 七力：锚点与下一步 ───────────── */

type Band = 'low' | 'mid' | 'high';
const band = (n: number): Band => (n <= 2 ? 'low' : n === 3 ? 'mid' : 'high');

const ANCHOR: Record<Force, Record<Band, string>> = {
  insight: {
    low: '只问了表面信息，客户没说的需求基本没挖出来。',
    mid: '问出了数量和规格，但没有追到客户为什么要买、什么时候要。',
    high: '主动追问了用量、时间和对手价背后的原因，把客户没说出口的需求挖了出来。',
  },
  guidance: {
    low: '被客户牵着走，对话没有明显的推进节奏。',
    mid: '能把话题往前带，但一次问得太多，客户只回答了其中一部分。',
    high: '每一轮都有明确的问题，客户答完再顺着追，节奏稳。',
  },
  solution: {
    low: '给的方案和客户的需求对不上，或者根本没给方案。',
    mid: '方案基本对口，但没有解释为什么这样配最适合他。',
    high: '方案紧扣客户的使用场景，分批、样品、定制的建议都有理由。',
  },
  trust: {
    low: '回答模板化，客户很难感到你是一个懂行的人。',
    mid: '态度专业，但缺少能让客户放心的凭据（证书、案例、样品）。',
    high: '主动提供了证书与样品，兑现了「今天发」的承诺，客户愿意继续谈。',
  },
  closing: {
    low: '对话结束时没有约定下一步，客户随时可能消失。',
    mid: '提到了会跟进，但没有给出明确的时间和动作。',
    high: '结束前拿到了联系方式，并说清了「明天上午发什么」。',
  },
  negotiation: {
    low: '价格被客户一压就让，没有拿到任何交换条件。',
    mid: '守住了一部分价格，但让价时没有和数量、节奏挂钩。',
    high: '让价都换到了东西：更大的数量、固定的订货节奏。',
  },
  stability: {
    low: '前后说法不一致，或者在压力下情绪明显波动。',
    mid: '大体稳定，个别地方被客户的话带偏。',
    high: '全程语气稳定，被压价也没有乱了阵脚。',
  },
};

const NEXT: Record<Force, string> = {
  insight: '下一局每次客户给出一个信息，就追问一句「为什么」或「什么时候」。',
  guidance: '下一局每轮只问一个问题，等客户回答完再问下一个。',
  solution: '给方案时先说一句「根据您刚才说的……」，再给建议。',
  trust: '报价之前先把证书或样品的承诺说清楚，并在当轮兑现。',
  closing: '每一局结束前，明确说出「我会在什么时候发什么给您」。',
  negotiation: '任何让价之前先问一句：「您大概的全年用量是多少？」',
  stability: '客户报出对手价时，先停一轮，问清对方规格再回应。',
};

/** 每个力最适合引用哪一轮当证据（对话里那一轮确实体现了这个力） */
const EVIDENCE_TURN: Record<Force, number> = {
  insight: 10,
  guidance: 4,
  solution: 11,
  trust: 7,
  closing: 14,
  negotiation: 9,
  stability: 8,
};

/* ───────────── 暗牌 ───────────── */

function unveilCards(turns: number, c: DemoCtx): UnveilItem[] {
  return [
    {
      card: '真实用量',
      what_it_was: fill('客户嘴上说首单 {qty} 件，其实全季用量是 {seasonQty} 件，会分两批下单。', c),
      missed_at_turn: turns >= 10 ? null : 3,
      how_to_get_it: fill('Is {qty}pcs for the first order only, or what is your total volume for the whole season?', c),
    },
    {
      card: '对手价背后的原因',
      what_it_was: fill('客户报出的 {rival} 来自一家交期不稳的供应商，他真正在意的是能不能按时上架。', c),
      missed_at_turn: turns >= 8 ? 8 : null,
      how_to_get_it: 'Is your current supplier always on time? Delivery before the high season seems important for you.',
    },
  ];
}

/* ───────────── 组装 ───────────── */

export interface DemoReportArgs {
  drillId: string;
  turns: number;
  difficulty: string;
  followup: boolean;
  ctx: DemoCtx;
  exitReason: string | null;
  facts: SessionFacts;
  /** 各力分数（1–5） */
  forceScores: Record<Force, number>;
  rawScore: number | null;
  tier: SessionScore['tier'];
  coverage: number;
  progress: 0 | 1 | 2;
  answerQuality: 0 | 1 | 2 | null;
  imprecise: boolean;
  difficultyFactor?: number;
  baselineScore?: number;
  coachQa: boolean;
}

export function buildDemoReport(a: DemoReportArgs): { reportMd: string; forces: ScoreOutput } {
  // 七力：证据引用的是这一局真实出现过的业务员原话
  const forces: ScoreOutput = {};
  for (const f of FORCES) {
    const score = a.forceScores[f];
    const turn = Math.min(EVIDENCE_TURN[f], a.turns);
    const r: ForceResult = {
      score: score as ForceResult['score'],
      evidence: [{ turn, quote: traineeLine(turn, a.ctx) }],
      anchor: ANCHOR[f][band(score)],
      next_action: NEXT[f],
    };
    forces[f] = r;
  }

  // 逐段点评：挑这一局打到过的、有点评的那几句，最多三段
  const segments: SegmentComment[] = [];
  TRAINEE_SCRIPT.forEach((l, i) => {
    const turn = i + 1;
    // 跟进局前两轮的台词被换掉了，原来的点评对不上，不挂
    if (a.ctx.followup && turn <= FOLLOWUP_TRAINEE.length) return;
    if (l.review && turn <= a.turns && segments.length < 3) {
      segments.push({
        turn,
        quote: traineeLine(turn, a.ctx),
        problem: fill(l.review.problem, a.ctx),
        coach_comment: fill(l.review.coach, a.ctx),
        better_reply_cn: fill(l.review.betterCn, a.ctx),
        better_reply_en: fill(l.review.betterEn, a.ctx),
      });
    }
  });

  const llm: ScoreLlmOutput = {
    forces,
    progress: a.progress,
    ...(a.answerQuality === null ? {} : { answer_quality: a.answerQuality as 0 | 1 | 2 }),
    segments,
    unveil: unveilCards(a.turns, a.ctx),
    one_action: '客户一报出对手价，先问清对方的规格和数量，再决定报不报价。',
  };

  const score: SessionScore = a.imprecise
    ? {
        precise: false,
        reason: '本局有效轮数偏少，评分证据覆盖率低于门槛，只给行为区间，不给精确分数。',
        coverage: a.coverage,
        evaluableCount: FORCES.length,
        flags: [],
      }
    : {
        precise: true,
        coverage: a.coverage,
        evaluableCount: FORCES.length,
        rawScore: a.rawScore ?? undefined,
        tier: a.tier,
        flags: [],
        ...(a.difficultyFactor === undefined ? {} : { difficultyFactor: a.difficultyFactor }),
        ...(a.baselineScore === undefined ? {} : { baselineScore: a.baselineScore }),
      };

  const reportMd = buildReport({
    drillId: a.drillId,
    turn: a.turns,
    difficulty: a.difficulty,
    followup: a.followup,
    exitReason: a.exitReason,
    facts: a.facts,
    llm,
    score,
    verified: forces,
    coachQa: a.coachQa ? COACH_QA : undefined,
  });

  return { reportMd, forces };
}
