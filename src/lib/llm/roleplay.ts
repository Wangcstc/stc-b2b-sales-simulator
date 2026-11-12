/**
 * 调用②｜角色扮演 + 防漏嘴（技术方案 5.1 / 5.2）
 *
 * ★ 三段 prompt ★
 *   段 1 固定前缀（可缓存）→ 段 2 动态注入（暗牌 + 行为指令）→ 段 3 对话历史
 * 段 1 必须**逐字节稳定**才命中缓存：不许有时间戳、轮次号、随机排序的数组。
 * 且 messages 里段 1 永远在最前面——段 2 跑到前面去，前缀就不稳定了。
 *
 * ★ 耐心/信任/离场一律不进 prompt ★
 * 它们在 engine/ 里。这里只负责把 decideDirective 的输出转成自然语言。
 * prompt 里出现「你自己判断客户还有多少耐心」→ 立刻停下重写。
 */

import type { Directive, DeliverableKind } from '../../../engine/types';
import { DELIVERABLE_LABEL, DELIVERABLE_FILENAME } from '../../../engine/types';
import type { HiddenCards, UnlockState, LeakHit } from '../../../engine/unlock';
import { checkLeak, buildLeakCorrection } from '../../../engine/unlock';
import { call } from './client';

export interface PersonaConfig {
  openCard: Record<string, unknown> & { inquiry_text: string };
  product: Record<string, unknown>;
  hiddenCard: HiddenCards;
  languageStyle: string;
}

/** 段 1：确定性拼装。字段顺序固定，不遍历对象（键序在不同环境可能变） */
export function buildSegment1(p: PersonaConfig): string {
  const o = p.openCard as Record<string, never> & { inquiry_text: string };
  const pr = p.product as Record<string, never>;
  return [
    '你现在扮演一个阿里国际站的海外买家，与一名中国供应商的新人业务员用英语对话。',
    '这是一次训练演习，对方是新人，你要像真实客户一样，不要迁就他。',
    '',
    '【人设明牌】',
    `姓名：${o.name}　国家：${o.country}　公司：${o.company}`,
    `买家等级：${o.buyer_level}　常采购类目：${(o.categories as unknown as string[]).join(' / ')}`,
    `近 90 天登录天数：${o.login_days_90d}　买家特征标签：${(o.tags as unknown as string[]).join(' / ')}`,
    `注册时间：${o.registered_at}　邮箱：${o.email}`,
    '',
    '【你发出的询盘原文】',
    o.inquiry_text,
    '',
    '【你正在询的产品】',
    `${pr.name}（型号 ${pr.model}）`,
    '',
    '════════ 第一铁律：你是【被动】的 ════════',
    '',
    '把这五条当成你这个角色的物理法则，不是建议：',
    '',
    '1. 【你只回答被问到的】。对方问什么，你答什么。他没问的，你一个字都不提。',
    '2. 【你绝不替对方把该问的问题问出来】。你不会说「是每个颜色 100 个还是一共 100 个？」——那是他的活。',
    '3. 【你绝不纠正他的任何误解】。他按错的数量报了价、算错了档位，你也只回一句 "Ok."，不提醒。',
    '4. 【你不会主动提起任何采购细节】——数量口径、交期、用途、你的门店、你的 logo 需求，统统不许由你先开口。',
    '5. 【着急不等于多话】。可以催"给我价格"，但催促里不许夹带任何他还没问到的信息。',
    '',
    '★ 判断标准 ★：说这句话之前先问自己——「他问过这件事吗？」没问过 → 不许说。没有例外。',
    '（系统会逐句扫描你的回复。说了对方还没问到的信息，本轮作废、要求重说。）',
    '',
    '【扮演基本规则】',
    `1. 只说客户会说的话。用英语，风格：${p.languageStyle}`,
    '2. 每次回复 2–4 句。',
    '3. 你不知道自己在被评分，不知道有"六要素"这个东西，不知道对方是新人。',
    '4. 你不是助手：不解释、不提建议、不夸奖对方的问题问得好。',
    // ★ 不再是"你也用英语回" ★（2026-08-23 红线④）
    // 老写法等于默许业务员发中文——客户照答，他就永远不知道这是错的。
    // 现在中文轮由代码接管（decideDirective 的 chineseReceived 分支），这里只兜底。
    '5. 你是海外买家，看不懂中文。对方要是发中文，你只能说你读不懂、请他用英文写。',
  ].join('\n');
}

/** 段 2：只注入已解锁的牌；未解锁的改写成"禁止透露 + 触发条件" */
export function buildSegment2(
  p: PersonaConfig,
  unlock: UnlockState,
  directive: Directive,
  distractor?: string,
  delivered: readonly DeliverableKind[] = [],
): string {
  const unlocked = new Set(unlock.unlocked);
  const lines: string[] = ['', '════════ 你手上的信息 ════════'];

  for (const [key, card] of Object.entries(p.hiddenCard)) {
    if (unlocked.has(key)) {
      lines.push(`- ${key}【已可以说】：${card.value}。被问到就自然、完整地说出来，不要挤牙膏。`);
    } else {
      lines.push(`- ${key}【绝对不能说】：解锁条件是「${card.unlock}」。条件没满足前，一个字都不许透露，也不许暗示。`);
    }
  }

  /**
   * ★ 已收到的资料（2026-08-19 反馈 #4）★
   *
   * 放在"你手上的信息"之后、"本轮要求"之前——它是**既成事实**，不是本轮动作。
   * 业务员反馈原话：「我说已发送了，他后面还是会问『请发给我，请发给我』。」
   * 那是因为客户 prompt 里从来没有"我已经收到过什么"这件事，他只能从聊天记录里
   * 猜，而一句 "I'll send you the catalog" 在真实世界里本来就等于还没发。
   *
   * 现在只有点过按钮、事实表里真有记录，这一段才会出现。口头承诺不会。
   */
  if (delivered.length > 0) {
    lines.push(
      '',
      '════════ 对方已经发给你、你已经收到的资料 ════════',
      ...delivered.map(
        (k) => `- ${DELIVERABLE_LABEL[k]}（附件 ${DELIVERABLE_FILENAME[k]}）—— 这份你已经收到并打开看过了。`,
      ),
      '★ 不许再向对方索要上面这些资料 ★ 不许说"请把目录发给我""我还没收到"这类话。',
      '要是你还想要别的东西，必须说清楚具体是什么（例如某个型号的报价、某个尺寸的图），',
      '不许再泛泛地要一份已经收到的资料。',
      '★ 收到资料不等于你就满意了 ★ 你可以对里面的内容提问、挑刺、说不是你要的那类，',
      '但前提是承认它已经到你手上了。',
    );
  }

  lines.push(
    '',
    '════════ 本轮表现要求（由系统下发，照做即可） ════════',
    `当前状态：patience ${directive.state.patience} / trust ${directive.state.trust} / interest ${directive.state.interest}`,
    ...directive.lines.map((l) => `- ${l}`),
  );

  /**
   * 干扰项是这一轮**唯一允许主动开口**的例外。
   * 放在最后，位置压过上面的被动铁律——但只放开这一句，说完立刻回到被动。
   */
  if (distractor) {
    lines.push(
      '',
      '════════ 本轮额外动作（这是第一铁律唯一的例外） ════════',
      '除了回应对方，你这一轮还要【主动】把下面这件事提出来，意思要完整传达：',
      `「${distractor}」`,
      '可以按你自己的口吻改写措辞，但不许改变意思、不许省略、不许拆到下一轮再说。',
      '★ 说完这一句就回到被动 ★ 不许顺带多说任何对方还没问到的信息。',
    );
  }

  lines.push('', '只输出客户说的英文，不要输出任何解释、标记或状态说明。');
  return lines.join('\n');
}

export interface RoleplayInput {
  persona: PersonaConfig;
  unlock: UnlockState;
  directive: Directive;
  history: { role: 'trainee' | 'customer'; content: string }[];
  sessionId?: string;
  /** 本轮要主动抛出的干扰项原话（由 engine/distractor.ts 挑好） */
  distractor?: string;
  /** 业务员已经真实投递给他的资料（点按钮发的）。口头说要发的不算，见 facts.deliverables */
  delivered?: readonly DeliverableKind[];
}

export interface RoleplayResult {
  reply: string;
  leakBlocked: LeakHit[][];
  usedFallback: boolean;
}

/** 判断干扰项到底有没有被说出来。太常见的词不算数，否则随便一句话都算命中 */
const STOP = new Set(
  ('the a an you your yours i my me we our us is are was were do does did have has had can could ' +
    'will would shall should just first need want them it its this that these those and or but not ' +
    'for with from to of in on at send give get some any other more please thanks thank hello okay ' +
    'let know tell about what when where which how why here there very much also still even only').split(' '),
);

function distractorLanded(reply: string, distractor: string): boolean {
  const key = (distractor.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w));
  if (key.length === 0) return true; // 提不出实词就别拦，宁可不追加
  const r = reply.toLowerCase();
  return key.some((w) => r.includes(w));
}

/**
 * 生成客户回复 + 三道防线里的第三道：输出后泄露检查。
 *
 * 2026-08-05 实测：拦截 2/2，均一次重生成即干净，没用到兜底。
 * 纠正指令必须写明"漏了哪个词、为什么不该说"——只说"重说一遍"，模型会原样再来一次。
 */
export async function roleplay(input: RoleplayInput): Promise<RoleplayResult> {
  const { persona, unlock, directive, history, sessionId, distractor, delivered } = input;
  const seg1 = buildSegment1(persona);
  const seg2 = buildSegment2(persona, unlock, directive, distractor, delivered ?? []);

  const base = [
    { role: 'system' as const, content: seg1 + seg2 },
    ...history.map((h) => ({
      role: (h.role === 'trainee' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: h.content,
    })),
  ];

  const leakBlocked: LeakHit[][] = [];
  const messages = [...base];

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await call({ purpose: 'roleplay', sessionId, temperature: 0.8, messages });
    const reply = res.content.trim();

    const hits = checkLeak(persona.hiddenCard, reply, unlock);
    if (hits.length === 0) {
      /**
       * ★ 干扰项必须真的说出口 ★（2026-08-06 实跑补）
       * 段 2 里已经写了「本轮必须主动提出」，但实测第 4 轮模型照样只答了被问的货代，
       * 把干扰项吞了——而事实表那边已经记成「已抛」，这条干扰项就永久消失了。
       * 兜底：没落地就把原话补成第二句。真实客户本来就常连发两条，读起来不违和。
       */
      const final = distractor && !distractorLanded(reply, distractor)
        ? `${reply}\n\n${distractor}`
        : reply;
      return { reply: final, leakBlocked, usedFallback: false };
    }

    leakBlocked.push(hits);
    if (attempt === 3) break;

    messages.push({ role: 'assistant', content: reply });
    messages.push({ role: 'user', content: buildLeakCorrection(hits) });
  }

  // 三次仍泄露 → 回退模板短回复，宁可干瘪也不能漏牌
  return { reply: 'Ok. Please send me the price.', leakBlocked, usedFallback: true };
}
