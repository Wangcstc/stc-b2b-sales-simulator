/**
 * 评分引擎（技术方案 8.1–8.5）
 *
 * ★ 事实表只读注入 ★
 * 凡事实表已判定的项，评分模型不得推翻、不得自行从聊天记录推断。
 * 它只负责评价"他这样问好不好"，不负责判断"他有没有问"。
 *
 * ★ 校准记录最高优先级 ★
 * Calibration 表里王老师的判例，注入位置在通用锚点【之前】并明写优先级。
 *
 * ★ 分数不让模型算 ★
 * 模型只给每一力的分与证据，加权、双门槛、段位映射全在 engine/scoring.ts 里用代码算。
 */

import type { Force, ScoreOutput, SessionFacts, SessionType } from '../../../engine/types';
import { FORCES, SIX_ELEMENTS, statusOf, DELIVERABLE_LABEL, quoteLines } from '../../../engine/types';
import { renderAnchors } from '../scoring-anchors';
import { call, parseToolArgs } from './client';
import { prisma } from '../db';

export interface ScoreLlmInput {
  sessionId: string;
  sessionType: SessionType;
  facts: SessionFacts;
  messages: { turn: number; role: string; content: string }[];
  hiddenCards: Record<string, { value: string; unlock: string }>;
  activeForces: Force[];
  naForces: Force[];
  coachQa?: { question: string; answer: string | null }[];
}

export interface SegmentComment {
  turn: number;
  quote: string;
  problem: string;
  coach_comment: string;
  better_reply_cn: string;
  better_reply_en: string;
}

export interface UnveilItem {
  card: string;
  what_it_was: string;
  missed_at_turn: number | null;
  how_to_get_it: string;
}

export interface ScoreLlmOutput {
  forces: ScoreOutput;
  progress: 0 | 1 | 2;
  answer_quality?: 0 | 1 | 2;
  segments: SegmentComment[];
  unveil: UnveilItem[];
  one_action: string;
}

/** 事实表渲染成只读证据块——由代码生成，模型不得改动 */
export function renderFacts(facts: SessionFacts): string {
  const el = SIX_ELEMENTS.map((k) => {
    const r = facts.elements[k];
    const st = statusOf(r);
    if (st === 'unasked') return `  ${k}：没问过`;
    // ★ 三态里最要紧的一档 ★ 他问了、客户没给。这不是他失职，是客户没答上——
    // 评分要看的是"他有没有追问、有没有换角度再问"，不是简单当成没问。
    if (st === 'asked_no_answer') {
      return (
        `  ${k}：★他问了（第${r.askedTurn}轮），客户${r.vague ? '只给了模糊回答' : '没有给'}★` +
        (r.askedQuote ? `　原话：「${r.askedQuote}」` : '')
      );
    }
    if (r.source === 'preset') return `  ${k}：★前情已定，本局不需要他问★`;
    const how = r.source === 'volunteered' ? '★客户主动给的，不算他问出来的★' : '他问出来的';
    return `  ${k}：已收集（第${r.turn}轮，${how}）` + (r.gotQuote ? `　客户原话：「${r.gotQuote}」` : '');
  }).join('\n');

  const asked = SIX_ELEMENTS.filter(
    (k) => facts.elements[k].source === 'asked' && statusOf(facts.elements[k]) === 'collected',
  ).length;
  const pending = SIX_ELEMENTS.filter((k) => statusOf(facts.elements[k]) === 'asked_no_answer');
  const vol = SIX_ELEMENTS.filter((k) => facts.elements[k].source === 'volunteered').length;
  const preset = SIX_ELEMENTS.filter((k) => facts.elements[k].source === 'preset').length;

  /**
   * ★ 有 preset 的局，「六要素收了几项」这道题本身就不成立 ★
   * 订单都建好了、产品包装物流全部谈定的跟进局，业务员再去问一遍产品参数，
   * 那不是洞察，是没看前情。所以要明确告诉模型：分母只有"该他问的那几项"，
   * 前情已定的既不算功劳也不算缺失——不写这一句，模型会照着"0/6"把洞察力判到最低档。
   */
  const sixLine =
    preset === 0
      ? [
          `  合计：他问出来的 ${asked} 项 ／ 客户主动给的 ${vol} 项`,
          `  ★洞察力的「六要素 N 项」只数「他问出来的」那 ${asked} 项，客户主动送上门的不算他的功劳★`,
        ]
      : [
          `  合计：前情已定 ${preset} 项 ／ 他问出来的 ${asked} 项 ／ 客户主动给的 ${vol} 项`,
          `  ★这是跟进局：${preset} 项在前情里就白纸黑字定死了，本局根本轮不到他问★`,
          `  ★所以「六要素收了几项」不适用于这一局，不许拿它给洞察力扣分。`,
          `    这一局的洞察力要看的是：他有没有读懂客户真正卡在哪、有没有问出前情里没有的那部分★`,
        ];

  // ★ 不写这一句，模型会把「问了客户没给」和「压根没问」判成同一档 ★
  // 那正是 2026-08-19 业务员喊冤的地方：明明问了，点评说他没问。
  const pendingLine = pending.length
    ? [
        `  ★他【问过但客户没给】的有 ${pending.length} 项：${pending.join('、')}★`,
        '    这几项不许按"他没问"来扣分。要评的是：客户不答之后他有没有换角度再问、有没有绕过去拿到，',
        '    还是问了一次就撂下不管了。',
      ]
    : [];

  const quotes =
    facts.quotes.length === 0
      ? '  本局未报价'
      : facts.quotes
          .map((q) => {
            // ★ 逐个产品喂给模型（2026-08-19 反馈 #6）★ 只给总额的话，
            // 模型点评多产品报价时只能看到一个数，说不出"第二个产品你没写型号"这种话。
            const lines = quoteLines(q);
            const detail = lines
              .map((l) => `      · ${l.product || '（未写产品名）'} USD ${l.unitPrice} × ${l.quantity}`)
              .join('\n');
            return (
              `  第${q.turn}轮：共 ${lines.length} 个产品，合计 USD ${q.total.toFixed(2)}，档位 ${q.tier}，` +
              `格式${q.formatCompliant ? '合规' : '不合规'}` +
              `${q.tradeTerms ? `，贸易术语 ${q.tradeTerms}` : '，★没填贸易术语★'}` +
              `${q.leadTimeDays ? `，交期 ${q.leadTimeDays} 天` : '，★没填交期★'}` +
              `${
                q.quantityMismatch
                  ? `\n    ★报价数量与客户真实需求不符——${
                      q.quantityConfirmed === false ? '他压根没把数量问确认就报了' : '客户给过数量，但他填的对不上'
                    }★`
                  : ''
              }\n${detail}`
            );
          })
          .join('\n');

  /**
   * ★ 交付动作必须进证据块（2026-08-19 反馈 #4）★
   *
   * 业务员反馈原话：「点评那块会说『为什么客户好几轮问你要目录，你一直拖着不给』
   * ——可我们早就说发了。」以前系统里没有这个动作，点评模型只能从聊天里猜，
   * 而客户（按被动铁律）会一直要，于是"拖着不给"几乎是必然结论。
   *
   * 现在发没发是一条确定的事实，和报价一样由代码给出，不许模型推翻。
   */
  const sent = facts.deliverables ?? [];
  const deliveredLines = [
    '已投递给客户的资料：',
    sent.length === 0
      ? '  本局没有投递过任何资料'
      : sent.map((d) => `  第${d.turn}轮：${DELIVERABLE_LABEL[d.kind]}（系统记录，确已送达客户）`).join('\n'),
    ...(sent.length
      ? [
          '  ★这几份资料客户【确实已经收到】★ 不许再判他"拖着不给资料""迟迟不发目录"。',
          '    要评的是：发得是不是时候（需求还没问清就先甩资料是减分的）、发完有没有接一句话把节奏拿回来。',
        ]
      : []),
    '',
  ];

  return [
    '以下事实由系统记录，绝对准确，你不得推翻或重新判断：',
    '',
    '六要素：',
    el,
    ...sixLine,
    ...pendingLine,
    '',
    `属性是否踩到底：${facts.attributeDrilled ? '是' : '否'}`,
    `数量是否分属性确认：${facts.quantitySplitConfirmed ? '是' : '否'}`,
    // 有 preset 的局永远凑不齐"六项全由他问出"，这个指标对跟进局没有意义，直接不摆出来
    ...(preset === 0 ? [`收齐六要素所用轮数：${facts.turnsToCollectAll ?? '未收齐'}`] : []),
    '',
    '报价记录：',
    quotes,
    '',
    ...deliveredLines,
    `红线触发：${facts.redlines.length ? facts.redlines.join('、') : '无'}`,
    `解锁暗牌：${facts.unlockedCards.length ? facts.unlockedCards.map((c) => `${c.key}(第${c.turn}轮)`).join('、') : '无'}`,
    `每轮是否抛问题：${facts.askedQuestionByTurn.map((b, i) => `轮${i + 1}${b ? '✓' : '✗'}`).join(' ')}`,
    '',
    '你的任务只是评价"他这样问好不好"，不是判断"他有没有问"。',
  ].join('\n');
}

const SCORE_PARAMETERS = {
  type: 'object',
  required: ['forces', 'progress', 'segments', 'unveil', 'one_action'],
  properties: {
    forces: {
      type: 'object',
      description: '逐力评分。每一力必须给：证据（轮次+逐字原话）、命中的锚点、分数、下一步动作',
      properties: Object.fromEntries(
        FORCES.map((f) => [
          f,
          {
            type: 'object',
            properties: {
              score: { description: '1-5 的整数，或字符串 NA / INSUFFICIENT' },
              evidence: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { turn: { type: 'integer' }, quote: { type: 'string' } },
                  required: ['turn', 'quote'],
                },
              },
              anchor: { type: 'string' },
              next_action: { type: 'string' },
            },
            required: ['score', 'evidence', 'anchor', 'next_action'],
          },
        ]),
      ),
    },
    progress: { type: 'integer', enum: [0, 1, 2], description: '即时推进度' },
    answer_quality: { type: 'integer', enum: [0, 1, 2], description: '复盘作答质量；未作答则省略' },
    segments: {
      type: 'array',
      description: '逐段点评，挑 3–5 个关键节点',
      items: {
        type: 'object',
        properties: {
          turn: { type: 'integer' },
          quote: { type: 'string' },
          problem: { type: 'string' },
          coach_comment: { type: 'string' },
          better_reply_cn: { type: 'string' },
          better_reply_en: { type: 'string' },
        },
        required: ['turn', 'quote', 'problem', 'coach_comment', 'better_reply_cn', 'better_reply_en'],
      },
    },
    unveil: {
      type: 'array',
      description: '掀开暗牌：每张牌是什么、他在第几轮错过、当时问一句什么就能拿到',
      items: {
        type: 'object',
        properties: {
          card: { type: 'string' },
          what_it_was: { type: 'string' },
          missed_at_turn: { type: 'integer' },
          how_to_get_it: { type: 'string' },
        },
        required: ['card', 'what_it_was', 'how_to_get_it'],
      },
    },
    one_action: { type: 'string', description: '这一局只练一个动作。只写一个，具体到一句话能执行' },
  },
} as const;

export async function scoreSession(input: ScoreLlmInput): Promise<ScoreLlmOutput> {
  /**
   * ★ 这张表里只该有「锚点问题」的判例 ★
   * 写入口在 api/session/[id]/calibrate：归因为取证问题（系统引的原话对不上记录）的
   * 一律不写进来——那要修的是引文校验，写成判例等于拿一条错误读数去掰弯一把准尺。
   * 这里再兜一道：判法为空的不注入，空判例喂给模型没有信息量，只会挤占 30 条的名额。
   */
  const calibrations = await prisma.calibration.findMany({
    where: { shouldBe: { not: '' } },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });

  const calibrationBlock =
    calibrations.length === 0
      ? '（暂无校准记录）'
      : calibrations.map((c) => `- 情形：${c.scenario}\n  应该怎么判：${c.shouldBe}\n  理由：${c.reason}`).join('\n');

  const transcript = input.messages
    .map((m) => `第${m.turn}轮 ${m.role === 'trainee' ? '业务员' : '客户'}：${m.content}`)
    .join('\n');

  const qaBlock =
    !input.coachQa || input.coachQa.length === 0
      ? '本局未做复盘问答。报告第一节按"因未作答，以下判断为系统推断"处理，作答质量不给分。'
      : input.coachQa.map((q, i) => `Q${i + 1}：${q.question}\nA${i + 1}：${q.answer ?? '（未作答）'}`).join('\n\n');

  const cards = Object.entries(input.hiddenCards)
    .map(([k, c]) => `- ${k}：真实情况「${c.value}」｜解锁条件：${c.unlock}`)
    .join('\n');

  const system = `你是阿里国际站业务员演习系统的评分引擎。

════════ 铁律（违反即整份评分作废） ════════
1. 这是演习分，命名为【演习段位 D】。你的任何文字里【禁止出现 L1/L2/L3/L4/L5 或"能力段位"】。
2. 事实表里已经判定的事情，你【不得推翻、不得重新判断】。
3. 每个分数都必须有证据。证据 = 轮次编号 + 从对话记录里【逐字复制】的原话。
   【不许改写、润色、概括引文】。引不出原话的维度，分数写 "INSUFFICIENT"。
   （系统会逐条回查引文能不能在记录里对上，对不上的一律降为证据不足——编引文没有任何好处。）
4. 【不许拿暗牌反推分数】。他没问出来的信息，不能因为你知道答案就说他"应该知道"。
   评分只看他做了什么，不看他本可以知道什么。
5. 分数你只给 1–5 / NA / INSUFFICIENT，【不要自己算加权分和段位】——那是系统用代码算的。

════════ 王老师校准记录（优先级高于下面所有通用锚点） ════════
${calibrationBlock}

════════ 评分锚点 ════════
${renderAnchors(input.activeForces, input.naForces)}

════════ 语气 ════════
像王老师：有话直说，不和稀泥，不给正确的废话，不羞辱人。
不许出现"继续加油""整体表现不错"这类空话。
逐段点评的话术要给中英双语，可变信息一律用 [方括号占位符]，不许编造客户没说过的事实。`;

  const user = [
    '【一、完整对话记录】',
    transcript,
    '',
    '【二、客观事实表 —— 只读，绝对准确】',
    renderFacts(input.facts),
    '',
    '【三、复盘问答】',
    qaBlock,
    '',
    '【四、本局人设暗牌全貌（只给报告第六节掀牌用，不许拿来反推分数）】',
    cards,
  ].join('\n');

  const doCall = () =>
    call({
      purpose: 'score',
      sessionId: input.sessionId,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'submit_score',
            description: '提交本局评分与点评',
            parameters: SCORE_PARAMETERS as unknown as Record<string, unknown>,
          },
        },
      ],
      toolChoice: { type: 'function', function: { name: 'submit_score' } },
    });

  // ★ 解析失败重试一次，和 extract.ts 一个口径（技术方案 2.3 约束②）★
  // 2026-08-14：这条链路原先是 `JSON.parse(res.toolArgs ?? '{}')` 裸解析，
  // DeepSeek 在这个最大的 schema 上返回过「合法 JSON + 尾巴」，直接把 /score 打成 500。
  // 注意这里**不能**沿用 `?? '{}'` 那个写法——解析失败时交出空对象，
  // 会变成一份"七力全空"的评分，和"这个人真的什么都没做到"长得一模一样。
  let parsed: Partial<ScoreLlmOutput>;
  try {
    parsed = parseToolArgs((await doCall()).toolArgs, 'score') as Partial<ScoreLlmOutput>;
  } catch (first) {
    try {
      parsed = parseToolArgs((await doCall()).toolArgs, 'score·重试') as Partial<ScoreLlmOutput>;
    } catch (second) {
      throw new Error(
        `评分模型两次都没返回可解析的 JSON。第一次：${(first as Error).message}；第二次：${(second as Error).message}`,
      );
    }
  }
  return {
    forces: normalizeForces(parsed.forces),
    progress: (parsed.progress ?? 0) as 0 | 1 | 2,
    answer_quality: parsed.answer_quality,
    segments: parsed.segments ?? [],
    unveil: parsed.unveil ?? [],
    one_action: parsed.one_action ?? '',
  };
}

/** 分数字段做一次守卫：越界的一律降为 INSUFFICIENT，不放行 */
function normalizeForces(raw: ScoreOutput | undefined): ScoreOutput {
  const out: ScoreOutput = {};
  for (const f of FORCES) {
    const item = raw?.[f];
    if (!item) continue;
    const s = item.score as unknown;
    const score =
      typeof s === 'number' && s >= 1 && s <= 5
        ? (Math.round(s) as 1 | 2 | 3 | 4 | 5)
        : s === 'NA'
          ? 'NA'
          : 'INSUFFICIENT';
    out[f] = {
      score,
      evidence: Array.isArray(item.evidence) ? item.evidence.filter((e) => e && typeof e.turn === 'number') : [],
      anchor: item.anchor ?? '',
      next_action: item.next_action ?? '',
    };
  }
  return out;
}
