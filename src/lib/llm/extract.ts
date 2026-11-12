/**
 * 调用①｜意图抽取（技术方案 4.3）
 *
 * ★ 抽取与扮演必须分成两次调用 ★
 * 让模型一边演客户一边给自己打标签，两边都会变差（工程纪律第 1 条）。
 *
 * ★ 必须带上下文 ★（2026-08-04 实测结论）
 * 30 条孤立样本回归时，`followup_level` 只有 86.7%——四条错的全是
 * "模型不知道这是第几次跟进"。那不是模型判不准，是我们没喂上下文。
 * 所以这里把前几轮对话摘要一起送进去。
 *
 * ★ 字段口径必须与标注集一致 ★
 * 与抽取标注集的「标注口径裁定」同源。改一边就要改另一边，
 * 否则准确率会低得莫名其妙——那不是模型不行，是标尺没对齐。
 */

import type { Extraction, CustomerExtraction } from '../../../engine/types';
import { SIX_ELEMENTS, QUESTION_TYPES, FOLLOWUP_LEVELS } from '../../../engine/types';
import { call } from './client';
import { guardExtraction, guardCustomerExtraction } from './schema-guard';

const EXTRACTION_PARAMETERS = {
  type: 'object',
  required: ['asked_elements', 'asked_question'],
  properties: {
    asked_elements: { type: 'array', items: { type: 'string', enum: [...SIX_ELEMENTS] } },
    /**
     * 逐项原话出处。老口径是整条消息只给一句 `evidence_quote`，
     * 引不出就把 `asked_elements` **整个数组**清空——一条消息问了三项、
     * 只引了一句原话，三项全没。所以改成逐项带引文、逐项校验。
     */
    asked_element_evidence: {
      type: 'array',
      items: {
        type: 'object',
        required: ['element', 'quote'],
        properties: {
          element: { type: 'string', enum: [...SIX_ELEMENTS] },
          quote: { type: 'string' },
        },
      },
    },
    quantity_split_confirmed: { type: 'boolean' },
    attribute_drilled: { type: 'boolean' },
    asked_question: { type: 'boolean' },
    question_type: { type: 'string', enum: [...QUESTION_TYPES] },
    has_altruistic_framing: { type: 'boolean' },
    affirmed_customer: { type: 'boolean' },
    emotional_expression: { type: 'boolean' },
    is_empty_chase: { type: 'boolean' },
    low_investment_on_suspicion: { type: 'boolean' },
    contradiction_probe: { type: 'boolean' },
    cited_bg_conclusion: { type: 'boolean' },
    sent_catalog: { type: 'boolean' },
    /**
     * ★ 补齐一条死规则 ★ `state-machine.ts` 的 `firstEmailWithImage`
     * （第一封开发信带图 → 进垃圾箱）一直挂在规则表里，但这个字段既不在本 schema、
     * 也不在 `schema-guard` 的白名单里 —— 抽取端永远给不出它，那条规则从未触发过。
     */
    email_with_attachment: { type: 'boolean' },
    followup_level: { type: 'string', enum: [...FOLLOWUP_LEVELS] },
    followup_has_hook: { type: 'boolean' },
    evidence_quote: { type: 'string' },
  },
} as const;

const SYSTEM = `你是阿里国际站业务对话的标注引擎。给你一条中国供应商业务员发给海外买家的消息，你按 schema 打标签。

通用规则：
1. 只标这一条消息里【真实存在】的行为，看不出来的一律 false / none / 空数组。
2. asked_elements 里出现的每一项，都必须能在这条消息里找到明确的语义依据。
3. evidence_quote 必须是原文里【逐字复制】的片段，不许改写、不许翻译、不许概括。找不到就留空字符串。
4. 你不评价好坏，不给建议，只打标签。行为对错与否不影响标签——错误的问法只要问了，就照实标。

★ asked_elements 的判据是【问的意图】，不是【用的词】★
业务员怎么措辞是他的自由，同义问法、隐含问法、把两件事合在一句里问，一律照实标。
判断标准只有一条：**海外买家读完这句话，知不知道对方在向他要这项信息**。知道就标。

  正例（都必须标 quantity）：
  - "How many pieces are you looking at for the first order?"
  - "What's your target volume?"
  - "Could you share the order size you have in mind?"
  - "Are we talking about a trial order or full container?"
  正例（都必须标 delivery_time）：
  - "When do you need them on the shelf?"     （问的是他的时间节点）
  - "Is there a deadline on your side?"
  反例（不标 delivery_time）：
  - "Our lead time is 35 days."               （他在【给】信息，不是在【要】信息）
  正例（标 product_attr + customization 两项）：
  - "Which material do you prefer, and do you need your logo printed?"

不要因为"他没用'数量'这个词"就漏标。**漏标的代价是业务员明明问了却被判成没问。**

字段口径（逐条严格执行）：
- asked_elements 六个值：product_attr 产品属性｜quantity 数量｜customization 定制需求
  address 收货地址或贸易条款｜delivery_time 期望到货时间｜other 其他
  ★other 的范围包括【问客户身份、问采购用途、问清关能力、兜底问还有没有其他要求】。
- asked_element_evidence：asked_elements 里的【每一项】都要在这里给一条对应的原话片段，
  逐字复制，不许改写。给不出原话的那一项会被丢弃，所以别标你引不出证据的项。
- sent_catalog：这条消息里【声称已发送或随附】了产品目录 / 产品册 / catalog / price list
  才是 true。只是承诺"稍后发给你"不算，问对方"要不要目录"也不算。
- email_with_attachment：这条跟进消息里带了图片、视频或附件才是 true。
- attribute_drilled：★只有"业务员追问客户要哪个具体属性值"才算 true。
  业务员在【回答】产品参数（如"刀片是 420 不锈钢"）【不算】，标 false。
- quantity_split_confirmed：追问了"这个数量是合计还是每个颜色/规格"才算 true。
- question_type：给了具体选项就是 choice；开放问句是 open；没问就是 none。
- has_altruistic_framing：★说明了对客户的好处就算 true。
- is_empty_chase：既没有新信息、又没有由头、也没有价值点的纯催促才是 true。
- low_investment_on_suspicion：只有这一条消息同时满足以下两点才是 true：①明确表达对客户真实性、诚意或付款能力的怀疑；②仅因这份怀疑而明显降低服务投入，例如敷衍打发、拒绝继续了解/解答、让客户自己处理或提前结束沟通。正常风控、核实身份、索要证明、谨慎提问都必须是 false。该字段只生成 R2 人工复核候选，不直接判违规。
- followup_level：★空催也占一级——发生在第 1 次跟进就标 "1"。没有跟进语境的正常对话才标 none。
- followup_has_hook：这次跟进带了由头且带了价值才是 true。空催一律 false。
- cited_bg_conclusion：引用了背调/网上查到的结论（不论对错）就是 true。`;

export interface ExtractInput {
  message: string;
  /** 前几轮对话摘要——没有它 followup_level 判不准 */
  context?: { turn: number; role: string; content: string }[];
  sessionId?: string;
}

export async function extract({ message, context = [], sessionId }: ExtractInput): Promise<{
  extraction: Extraction;
  violations: string[];
}> {
  const contextBlock =
    context.length === 0
      ? '（这是本局第一条消息，没有上文）'
      : context
          .slice(-6)
          .map((m) => {
            const who = m.role === 'trainee' ? '业务员' : m.role === 'system' ? '【本局前情】' : '客户';
            return m.turn === 0 ? `${who}
${m.content}` : `第${m.turn}轮 ${who}：${m.content}`;
          })
          .join('\n');

  const user = `【前几轮对话（判断跟进级别、是否空催时必须参考）】\n${contextBlock}\n\n【要标注的这一条业务员消息】\n${message}`;

  const doCall = () =>
    call({
      purpose: 'extract',
      sessionId,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'record_extraction',
            description: '记录这条业务员消息的结构化标签',
            parameters: EXTRACTION_PARAMETERS as unknown as Record<string, unknown>,
          },
        },
      ],
      toolChoice: { type: 'function', function: { name: 'record_extraction' } },
    });

  let raw: unknown;
  try {
    const res = await doCall();
    raw = JSON.parse(res.toolArgs ?? '{}');
  } catch {
    // 整条 JSON 解析失败才重试，上限 1 次（技术方案 2.3 约束②）
    try {
      const retry = await doCall();
      raw = JSON.parse(retry.toolArgs ?? '{}');
    } catch {
      return { extraction: { asked_elements: [], asked_question: false }, violations: ['两次解析失败，本轮抽取放弃'] };
    }
  }

  return guardExtraction(raw as Record<string, unknown>, message);
}

// ───────────────────────── 调用④｜客户侧抽取 ─────────────────────────

/**
 * ★ 这个调用 2026-08-23 之前根本不存在 ★
 *
 * 系统原来只抽业务员那一条消息，六要素在「业务员问了」的那一刻就被打成已收集。
 * 于是两个反方向的错同时成立：
 *   - 问了、客户没答 → 照样打勾（业务员反馈的第一大问题）
 *   - 客户明明答了 → 抓不到（因为压根没读客户那句话）
 *
 * 抽取纪律与调用① 完全一致：**每一项必须带客户原话逐字引文**，
 * 引不出的在 `guardCustomerExtraction()` 里逐项丢弃。宁可漏，不可编。
 */
const CUSTOMER_EXTRACTION_PARAMETERS = {
  type: 'object',
  required: ['answered_elements'],
  properties: {
    answered_elements: {
      type: 'array',
      items: {
        type: 'object',
        required: ['element', 'quote'],
        properties: {
          element: { type: 'string', enum: [...SIX_ELEMENTS] },
          quote: { type: 'string' },
        },
      },
    },
    vague_elements: { type: 'array', items: { type: 'string', enum: [...SIX_ELEMENTS] } },
  },
} as const;

const CUSTOMER_SYSTEM = `你是阿里国际站业务对话的标注引擎。给你一条【海外买家发给中国供应商】的消息，
你只回答一个问题：**这条消息里，买家真的给出了六要素中的哪几项。**

六要素：product_attr 产品属性｜quantity 数量｜customization 定制需求
address 收货地址或贸易条款｜delivery_time 期望到货时间｜other 其他（身份/用途/清关能力等）

判定口径（严格执行）：
1. 只有买家给出了【实质性、可据以行动】的信息，才放进 answered_elements。
   - "We need 2,000 pcs."                → quantity ✅
   - "Ship to Rotterdam, FOB."           → address ✅
   - "We need them before Nov 15."       → delivery_time ✅
   - "Stainless steel, 1.2mm."           → product_attr ✅
2. 模糊、回避、推脱的，放进 vague_elements，【不要】放进 answered_elements：
   - "A lot." / "Depends." / "We'll see." / "Quite a few." / "As soon as possible."
   - "Send me your best price first."    （这是回避数量，不是给数量）
3. 买家【反过来提问】不算给信息：
   - "How many colors do you have?"      → 什么都不标
   - "What's your MOQ?"                  → 什么都不标（他在问你，不是在答你）
4. 买家明确【拒绝】给（"I can't share that yet."）→ 什么都不标，也不进 vague。
5. quote 必须是这条消息里【逐字复制】的片段，不许改写、不许翻译、不许概括。
   引不出原话的那一项，宁可不标。

你不评价好坏，不猜他心里想什么，只标这条消息里白纸黑字给出来的东西。`;

export interface CustomerExtractInput {
  /** 客户这一条回复的原文 */
  reply: string;
  /** 业务员上一条问了什么——判断"这是在答我"还是"他自己提起的"需要它 */
  askedContext?: string;
  sessionId?: string;
}

export async function extractCustomer({
  reply,
  askedContext,
  sessionId,
}: CustomerExtractInput): Promise<CustomerExtraction> {
  // 空回复、纯离场标记不值得花一次调用
  const text = reply.trim();
  if (!text || text.includes('[客户已离开对话]')) {
    return { answered_elements: [], vague_elements: [] };
  }

  const user = [
    askedContext ? `【业务员上一条说了什么（只作参考，不要标它）】\n${askedContext}\n` : '',
    `【要标注的这一条买家消息】\n${text}`,
  ].join('\n');

  try {
    const res = await call({
      purpose: 'extract',
      sessionId,
      temperature: 0,
      messages: [
        { role: 'system', content: CUSTOMER_SYSTEM },
        { role: 'user', content: user },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'record_customer_extraction',
            description: '记录这条买家消息里真的给出了哪几项六要素',
            parameters: CUSTOMER_EXTRACTION_PARAMETERS as unknown as Record<string, unknown>,
          },
        },
      ],
      toolChoice: { type: 'function', function: { name: 'record_customer_extraction' } },
    });
    return guardCustomerExtraction(JSON.parse(res.toolArgs ?? '{}') as Record<string, unknown>, text);
  } catch {
    // ★ 抽不出来就当客户没给 ★ 不重试、不猜。
    // 这一条失败的后果是「本该打勾的没打勾」，业务员下一轮追问一次就补回来了；
    // 反过来猜一个 collected 出来，红线①就会漏判——那是不可逆的。
    return { answered_elements: [], vague_elements: [] };
  }
}
