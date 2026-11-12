/**
 * 教练式复盘问答（需求第 7 章 · v2.0 核心新增）
 *
 * ★ 这是 v2.0 区别于 v1.0 的灵魂机制 ★
 * v1.0 局一结束直接吐报告，新人被动接收结论——**与王老师的教练的方式正好相反**。
 * wang-sales-coach v3.0：「王老师从不自问自答：提问是为了拿到业务员脑子里的信息和想法，
 * 没拿到答案之前，不做诊断。」
 *
 * ★ 一次只问一个 ★
 * 5 个问题一次全列出来，新人会扫一眼挑简单的答、互相参照着编。逐一提问才逼得出真话。
 *
 * ★ 后端硬闸在 score/route.ts ★
 * 前端藏按钮不算数。5 答未齐，评分接口直接拒绝。
 */

import type { SessionFacts } from '../../../engine/types';
import { call } from './client';
import { renderFacts } from './score';

/** 7 个提问角度（取自 wang-sales-coach v3.0，演习场景化） */
export const QUESTION_ANGLES = [
  '搞清楚模糊或异常的信息点',
  '关键信息确认（六要素拿到没）',
  '提问他对客户的了解程度（背调看了吗）',
  '了解某个节点当时的想法（"你第 6 轮为什么这么回"）',
  '指出明显漏洞并探究原因（"他都把地址给你了你为什么不推进"）',
  '探究他对客户需求的理解深度（"他坚持要这个，你觉得背后的需求是什么"）',
  '引导他梳理整个过程（"三句话捋一遍这局"）',
] as const;

/** 后 2 个固定问题，一字不改（需求 7.2） */
export const FIXED_QUESTIONS = [
  '你认为这一局推进订单最大的阻力是什么？',
  '如果重来，下一步你应该怎么回？',
] as const;

export interface GenerateInput {
  sessionId: string;
  facts: SessionFacts;
  messages: { turn: number; role: string; content: string }[];
}

export async function generateQuestions(input: GenerateInput): Promise<string[]> {
  const transcript = input.messages
    .map((m) => `第${m.turn}轮 ${m.role === 'trainee' ? '业务员' : '客户'}：${m.content}`)
    .join('\n');

  const system = `你是一位外贸业务教练，正在给一名刚打完一局演习的新人做复盘。
教练风格来自王老师：有话直说，不和稀泥，不给正确的废话，但不羞辱人。

你现在【只出题，不评价】。拟 3 个针对性问题，要求：

1. 必须从下面 7 个角度里选【3 个不同的角度】：
${QUESTION_ANGLES.map((a, i) => `   ${i + 1}. ${a}`).join('\n')}

2. 每个问题都必须【扎在这一局真实发生的事情上】，并引用具体轮次。
   反例（不许这样问）：「你觉得这局表现怎么样？」——这是废问题。
   正例：「你第 6 轮直接报了价，当时为什么觉得可以报了？」

3. 【不许在问题里夹带答案】，不许暗示对错。
   反例：「你是不是因为没问数量才报错了档位？」——这是自问自答。
   正例：「你报价时用的数量是从哪里来的？」

4. 一句话一个问题，不要铺垫，不要客套。`;

  const user = `【本局对话记录】\n${transcript}\n\n【客观事实表】\n${renderFacts(input.facts)}`;

  const res = await call({
    purpose: 'coachQa',
    sessionId: input.sessionId,
    temperature: 0.3,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'submit_questions',
          description: '提交 3 个针对性复盘问题',
          parameters: {
            type: 'object',
            required: ['questions'],
            properties: {
              questions: {
                type: 'array',
                minItems: 3,
                maxItems: 3,
                items: {
                  type: 'object',
                  required: ['angle', 'question'],
                  properties: {
                    angle: { type: 'integer', description: '用的是第几个提问角度（1-7）' },
                    question: { type: 'string' },
                  },
                },
              },
            },
          } as unknown as Record<string, unknown>,
        },
      },
    ],
    toolChoice: { type: 'function', function: { name: 'submit_questions' } },
  });

  const parsed = JSON.parse(res.toolArgs ?? '{}') as { questions?: { question: string }[] };
  const targeted = (parsed.questions ?? []).map((q) => q.question).filter(Boolean).slice(0, 3);

  // 模型没给够就用兜底题补齐——宁可问得平淡，也不能少问
  while (targeted.length < 3) {
    targeted.push(FALLBACK_QUESTIONS[targeted.length] ?? '这一局你觉得哪一步走错了？为什么？');
  }

  return [...targeted, ...FIXED_QUESTIONS];
}

const FALLBACK_QUESTIONS = [
  '六要素里你觉得自己漏了哪几项？为什么当时没问？',
  '客户这一局里有哪句话是你没听懂或者没在意的？',
  '三句话捋一遍这一局的过程。',
];

/**
 * 追问判定（需求 7.2）：答得含糊就追问一次，**不递归**。
 * 用一次轻量调用判断，不值得为它上强模型。
 *
 * ★ 必须带上本局对话（2026-08-24 补，08-19 反馈 #9 第三条）★
 * 业务员原话：「追问也只会根据我们的回答，就有点太死板了。」——那是实话：
 * 这个函数原来只收到「问题 + 回答」两句，**看不见这一局到底发生了什么**，
 * 于是它只能对着回答本身车轱辘话（"你确定？""你怎么知道的？"）。
 * 出题那一步（`generateQuestions`）明明喂了完整对话，追问却没有，
 * 一局里前后两句话的信息量差着一整局。
 *
 * 给了上下文，追问才能落到"你第 6 轮明明已经拿到地址了"这种话上。
 */
export async function checkVague(
  sessionId: string,
  question: string,
  answer: string,
  transcript?: string,
): Promise<{ isVague: boolean; followUp?: string }> {
  // 明显敷衍的先用代码判掉，省一次调用
  const trimmed = answer.trim();
  if (trimmed.length < 6 || /^(不知道|没有|不清楚|没想过|忘了|no idea|idk)/i.test(trimmed)) {
    return { isVague: true, followUp: '你确定？那你当时脑子里在想什么？说一句真话就行。' };
  }

  const res = await call({
    purpose: 'coachQa',
    sessionId,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `判断一个新人业务员的复盘回答是不是【含糊】。

含糊 = 只复述了发生了什么、说不出为什么；或"感觉吧""应该是"这类模糊表述；或答非所问。
不含糊 = 说出了自己当时的判断依据，哪怕这个判断是错的。

含糊就给一句追问。追问要像王老师：短、直接、不客气但不羞辱。

★ 追问必须扎在这一局真实发生的事上 ★
给了你【本局对话记录】就一定要用：指名道姓地问他第几轮说的哪句话、客户当时给了什么。
　　好：「客户第 4 轮就把到货时间给你了，你第 7 轮还在问——当时没看到还是没当回事？」
　　差：「你确定？」「你怎么知道的？」——这两句谁都能问，等于没问。
只有在对话记录里实在找不到抓手时，才允许用这种通用追问。
一句话，不超过 40 字，不要铺垫。`,
      },
      {
        role: 'user',
        content: [
          ...(transcript ? [`【本局对话记录】\n${transcript}\n`] : []),
          `【复盘问题】${question}`,
          `【他的回答】${answer}`,
        ].join('\n'),
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'judge',
          description: '判断回答是否含糊',
          parameters: {
            type: 'object',
            required: ['is_vague'],
            properties: {
              is_vague: { type: 'boolean' },
              follow_up: { type: 'string', description: '含糊时给一句追问；不含糊留空' },
            },
          } as unknown as Record<string, unknown>,
        },
      },
    ],
    toolChoice: { type: 'function', function: { name: 'judge' } },
  });

  const parsed = JSON.parse(res.toolArgs ?? '{}') as { is_vague?: boolean; follow_up?: string };
  return parsed.is_vague
    ? { isVague: true, followUp: parsed.follow_up?.trim() || '你确定？你怎么知道的？' }
    : { isVague: false };
}
