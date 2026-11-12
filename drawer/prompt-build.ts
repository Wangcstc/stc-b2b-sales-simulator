/**
 * 把标准层的固定指令和本次的题型、素材、产品资料拼成一次模型调用。
 * 只拼字符串，不调模型；测试可以直接断言拼出来的内容。
 */
import { QUALITY_RULES, SYLLABUS, type SyllabusType } from '../standards/index';
import type { Persona } from '../bank-kit/index';
import type { RawChat } from './ingest/chat-parse';
import type { CatalogEntry } from './materials';
import type { Problem } from './qa/regex';

/** 素材正文最多给模型多少字符（超长对话只取开头和结尾，中间折叠） */
const MAX_CHARS = 24000;

const DAY = 86_400_000;

/**
 * 素材正文：每条消息一行，日期变了插一行分隔并写明「隔了几天」。
 * ★ 日期必须给 ★ 报价沉默、样品沉默这类题型，判断依据就是买家隔了多久才回、业务员追了几次。
 */
export function materialText(chat: RawChat): string {
  const lines: string[] = [];
  let lastDate: string | null = null;
  chat.messages.forEach((m, i) => {
    if (m.date && m.date !== lastDate) {
      const gap = lastDate ? Math.round((Date.parse(m.date) - Date.parse(lastDate)) / DAY) : null;
      lines.push(`—— ${m.date}${gap && gap > 0 ? `（距上一条消息 ${gap} 天）` : ''} ——`);
      lastDate = m.date;
    }
    lines.push(`[${i}] ${m.side === 'client' ? '买家' : '业务员'}：${m.text.replace(/\s+/g, ' ').trim()}`);
  });
  const all = lines.join('\n');
  if (all.length <= MAX_CHARS) return all;
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  for (let a = 0, b = lines.length - 1; a <= b && used < MAX_CHARS; ) {
    if (head.length <= tail.length) used += (head[head.length] = lines[a++]!).length;
    else used += (tail[tail.length] = lines[b--]!).length;
  }
  return [...head, `……（中间 ${lines.length - head.length - tail.length} 行从略）……`, ...tail.reverse()].join('\n');
}

/** 素材抬头。★ 买家化名必须给 ★ 正文每行只标「买家 / 业务员」，不给名字模型就会把公司名当人名写 */
function headerText(chat: RawChat): string {
  const name = chat.header['客户'];
  const h = [
    ...(name ? [`买家姓名（化名）：${name}`] : []),
    ...Object.entries(chat.header)
      .filter(([k]) => ['地区', '消息数量', '时间范围'].includes(k))
      .map(([k, v]) => `${k}：${v}`),
  ];
  const c = chat.customer ? Object.entries(chat.customer.fields).slice(0, 12).map(([k, v]) => `${k}：${v}`) : [];
  return [...h, ...c].join('\n');
}

export function triagePrompt(chat: RawChat): { system: string; user: string } {
  const types = SYLLABUS.types
    .map((t) => `${t.code} ${t.name}（${t.session_type === 'followup' ? '跟进局' : '询盘局'}）｜买家画像：${t.buyer_profile}｜素材信号：${t.material_signals}`)
    .join('\n');
  return {
    system: '',
    user: `## 考纲题型清单（考纲 v${SYLLABUS.syllabus_version}）\n${types}\n\n## 素材抬头\n${headerText(chat)}\n\n## 聊天记录（方括号里是 message_index）\n${materialText(chat)}`,
  };
}

/** 几个模型容易写错含义的字段。起草、变体、修订三处共用 */
export const FIELD_NOTES = `字段说明：
- quote_reactions：业务员报价后买家的反应。compliant = 报价规范（数量确认过、格式合规）时的回复；redline_R1 = 业务员没确认数量就报价（红线 R1）时买家冷淡敷衍的回复；qty_mismatch = 报价数量和买家说的对不上；oneline_big_quote = 大额订单只回一句话报价、没有正式报价单。
- preset_elements：只有跟进局写，列出前情里已经谈定的六要素代码，只能从 product_attr / quantity / customization / address / delivery_time / other 里选，不要写具体内容。询盘局写空数组。
- followup_reactions：只有跟进局写，键名用英文。`;

const FORMAT = `## 输出格式
{
  "product_sku": "产品资料里的产品编号",
  "difficulty": "simple_with_distractors | standard | hard（只能选本题型允许的档）",
  "tests": "这一局具体考什么（中文一句）",
  "open_card": {"name": "买家化名", "country": "英文标准国名，如 United States", "company": "公司名；素材里没有就虚构一个与国家相称的", "buyer_level": "A/B/C", "categories": [], "login_days_90d": 0, "product_views_90d": 0, "valid_inquiries_90d": 0, "tags": [], "registered_at": "YYYY-MM", "email": "xxx@xxx.example", "inquiry_text": "买家的第一条询盘（英文）"},
  "hidden_card": {"H1_英文短名": {"value": "", "unlock": "", "unlock_patterns": [], "requires": [], "leak_signals": []}},
  "leak_fallback": "业务员问不到点子上时买家的敷衍回复（英文）",
  "distractors": [{"code": "D1", "turn_range": [3, 4], "content": "英文", "tests": "考什么", "unlocks": null, "scoring": "怎么计分"}],
  "customs_capability": "进口清关情况（中文）",
  "init_state": {"patience": 60, "trust": 50, "interest": 60},
  "exit_lines": {"maxTurns": "英文", "patienceZero": "英文或 null", "stagnant": "英文或 null"},
  "quote_reactions": {"compliant": "英文", "redline_R1": "英文", "qty_mismatch": "英文", "oneline_big_quote": "英文"},
  "followup_reactions": {"still_reviewing": "英文；只有跟进局写这个字段，询盘局不要写"},
  "language_style": "这个买家怎么说话（中文）",
  "preset_elements": ["quantity", "address"],
  "product_surcharges": {"可选：定制加价项": 0.3},
  "verify_cases": [{"card": "H1_英文短名", "should": [], "shouldNot": []}],
  "source_quotes": [{"card": "H1_英文短名", "message_index": 2, "quote": "逐字原话"}, {"card": "H5_xxx", "invented": true, "why": "补写理由"}]
}


${FIELD_NOTES}`;

function typeBrief(t: SyllabusType): string {
  const allowed = [t.default_difficulty, ...t.also_difficulties].join(' / ');
  return [
    `题型：${t.code} ${t.name}（${t.stage_name}，${t.session_type === 'followup' ? '跟进局：买家已经谈过一轮，业务员来跟进' : '询盘局：买家发来第一条询盘'}）`,
    `买家画像：${t.buyer_profile}`,
    `考点：${t.tests}`,
    `满分表现：${t.full_marks}`,
    `典型错误：${t.typical_mistakes}`,
    `暗牌设计提示：${t.hidden_card_tips}`,
    `允许的难度档：${allowed}（默认 ${t.default_difficulty}）`,
  ].join('\n');
}

function qualityBrief(): string {
  const q = QUALITY_RULES;
  return `暗牌 ${q.hidden_cards.min}–${q.hidden_cards.max} 张；每张解锁正则至少 ${q.unlock_patterns_per_card.min} 条；每张验证用例 should 至少 ${q.verify_should_per_card.min} 句、shouldNot 至少 ${q.verify_should_not_per_card.min} 句；干扰项最多 ${q.distractors.max} 条；开局三项取 ${q.init_state_range.min}–${q.init_state_range.max}。`;
}

export function draftPrompt(
  t: SyllabusType,
  chat: RawChat,
  candidates: { fact: string; message_index: number; quote: string }[],
  catalog: CatalogEntry[],
  company: Record<string, string> | undefined,
): { user: string } {
  return {
    user: [
      `## 本题题型\n${typeBrief(t)}`,
      `## 质量门槛\n${qualityBrief()}`,
      `## 卖家公司资料（业务员这一方）\n${company && Object.keys(company).length ? Object.entries(company).map(([k, v]) => `${k}：${v}`).join('\n') : '（未提供）'}`,
      `## 产品资料（价格以此为准）\n${JSON.stringify(catalog, null, 1)}`,
      `## 候选暗牌（归型时找到的，可增删）\n${candidates.map((c) => `- ${c.fact}（第 ${c.message_index} 条：${c.quote}）`).join('\n') || '（无）'}`,
      `## 素材抬头\n${headerText(chat)}`,
      `## 聊天记录（方括号里是 message_index）\n${materialText(chat)}`,
      FORMAT,
    ].join('\n\n'),
  };
}

/** 题目里交给模型改的部分（去掉代码负责的字段） */
export function editableOf(p: Persona): Record<string, unknown> {
  const { id: _i, derived_from: _d, skeleton: _s, product: _p, _source: _src, pool_type: _pt, ...rest } = p as Persona & Record<string, unknown>;
  return rest;
}

export function variantPrompt(mother: Persona, index: number, avoidCountries: string[]): { user: string } {
  return {
    user: [
      `这是第 ${index + 1} 个变体。新买家的国家不要用：${avoidCountries.join('、') || '（无限制）'}。`,
      `## 题型\n${mother.skeleton.type_code} ${mother.skeleton.name}：${mother.skeleton.tests}`,
      `## 产品（不变）\n${JSON.stringify(mother.product, null, 1)}`,
      `## 母题\n${JSON.stringify(editableOf(mother), null, 1)}`,
      FIELD_NOTES,
    ].join('\n\n'),
  };
}

export function revisePrompt(p: Persona, problems: Problem[], note?: string, material?: { text: string[] } | null): { user: string } {
  // 引文对不上素材时，模型要看得到原文才改得对
  const needSource = Boolean(material?.text.length) && problems.some((x) => /原话|素材/.test(x.what));
  const issues = problems.filter((x) => x.level === '✗').map((x) => `- ${x.what}`);
  return {
    user: [
      issues.length ? `## 没通过的质检项\n${issues.join('\n')}` : '',
      note ? `## 主管的修改意见\n${note}` : '',
      needSource ? `## 素材原文（source_quotes 的 quote 必须从这里逐字照抄，message_index 是方括号里的编号）\n${material!.text.map((t, i) => `[${i}] ${t.replace(/\s+/g, ' ').trim()}`).join('\n').slice(0, 24000)}` : '',
      `## 产品（价格以此为准，不要改）\n${JSON.stringify(p.product, null, 1)}`,
      `## 当前题目（tests 是这一局具体考什么，可以改）\n${JSON.stringify({ tests: p.skeleton.tests, ...editableOf(p), source_quotes: p._source?.quotes ?? [] }, null, 1)}`,
      FIELD_NOTES,
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}

/** 模型偶尔会把 JSON 包在 ```json 里，或前后多说一句话 */
export function parseJsonObject(text: string): Record<string, unknown> {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b <= a) throw new Error('模型没有返回 JSON 对象');
  const v = JSON.parse(t.slice(a, b + 1)) as unknown;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('模型返回的不是 JSON 对象');
  return v as Record<string, unknown>;
}

export function bgPrompt(p: Persona, problems: Problem[] = []): { user: string } {
  const cards = Object.entries(p.hidden_card)
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, c]) => `- ${k}：${(c as { value: string }).value}`)
    .join('\n');
  const issues = problems.filter((x) => x.level === '✗').map((x) => `- ${x.what}`);
  return {
    user: [
      `## 题目\n${p.skeleton.type_code} ${p.skeleton.name}：${p.skeleton.tests}`,
      `## 买家明牌\n${JSON.stringify(p.open_card, null, 1)}`,
      `## 暗牌（真相以这里为准）\n${cards}`,
      issues.length ? `## 上一版背调包没通过的质检项，逐条修好\n${issues.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}
