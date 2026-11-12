/**
 * 审题单：把一批里待确认的题排成人读的 Markdown，给主管点选确认卡之前看。
 *
 * 每道题一节：买家明牌、暗牌与出处、干扰项、报价反应、机器提醒，再加一份「机器看不出来、要人看」的清单。
 * ★ 按当前的闸门重新复查一遍 ★ 闸门升级后，早先过闸的题可能有新问题，审题单上直接标出来，
 *    复查只跑代码，不调模型、不花钱。
 * 审题单写在批次目录里（workspace/ 不进 git），里面有脱敏后的素材原文。
 */
import { syllabusType } from '../standards/index';
import type { Persona } from '../bank-kit/index';
import { runGates } from './qa/gate';
import { checkVariant } from './qa/variant';
import type { Store } from './store';
import type { Item, Question, ReviewCard } from './types';

const DIFF: Record<string, string> = { simple_with_distractors: '简单', standard: '标准', hard: '困难' };
const esc = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const quote = (s: string) => s.split('\n').map((l) => `> ${l}`).join('\n');

interface Material {
  chat: { messages: { side: string; date: string | null; text: string; textCn?: string }[] };
}

function section(n: number, it: Item, q: Question, card: ReviewCard | undefined, m: Material | null, catalog: unknown[] | undefined, mother?: Persona): string {
  const p: Persona = q.persona;
  const t = syllabusType(p.skeleton.type_code);
  const cards = Object.entries(p.hidden_card).filter(([k]) => !k.startsWith('_')) as [string, Record<string, unknown>][];
  const quotes = new Map((p._source?.quotes ?? []).map((x) => [x.card, x]));
  const invented = (p._source?.quotes ?? []).filter((x) => x.invented).length;
  const g = runGates(p, m ? { text: m.chat.messages.map((x) => x.text), textCn: m.chat.messages.map((x) => x.textCn ?? '') } : null, catalog as never);
  const recheck = mother ? { ...g, problems: [...g.problems, ...checkVariant(mother, p)] } : g;
  const hard = recheck.problems.filter((x) => x.level === '✗');
  const warn = recheck.problems.filter((x) => x.level === '⚠');
  const oc = p.open_card;
  const out: string[] = [];

  out.push(`## ${n}. ${p.id} ${p.skeleton.name}${q.kind === 'variant' ? `（变体，母题 ${q.parent}）` : ''}`);
  out.push('');
  out.push(`**${t?.session_type === 'followup' ? '跟进局' : '询盘局'} · ${DIFF[p.skeleton.difficulty] ?? p.skeleton.difficulty} · ${p.pool_type === 'drill' ? '演习池' : '考试池'}** ｜ 确认卡 \`${card?.id ?? '—'}\` ｜ 机制难度指数 ${recheck.index ?? '—'} ｜ 修订 ${q.attempts} 次`);
  out.push('');
  if (it.triage && q.kind === 'mother') {
    out.push(`- **归型**：信心 ${it.triage.confidence}，备选 ${it.triage.alt_types.join('、') || '无'}。${it.triage.reason}`);
  }
  out.push(`- **考点**：${p.skeleton.tests}`);
  out.push(`- **复查（按当前闸门，不花钱）**：${hard.length ? `✗ ${hard.length} 个硬问题——建议选「退回修订」` : '✓ 无硬问题'}${warn.length ? `，⚠ ${warn.length} 个提醒` : ''}`);
  for (const x of hard) out.push(`  - ✗ ${x.what}`);
  out.push('');

  out.push('### 买家（业务员看得到的明牌）');
  out.push('');
  out.push(`${oc.name}｜${oc.country}｜${oc.company}｜等级 ${esc(oc.buyer_level)}｜90 天登录 ${esc(oc.login_days_90d)} 天、看产品 ${esc(oc.product_views_90d)} 个`);
  out.push('');
  out.push(quote(oc.inquiry_text));
  out.push('');
  out.push(`- **说话风格**：${p.language_style}`);
  out.push(`- **开局**：耐心 ${p.init_state.patience}、信任 ${p.init_state.trust}、兴趣 ${p.init_state.interest}`);
  out.push(`- **产品**：${p.product.model ?? ''} ${p.product.name}`);
  if (p.preset_elements?.length) out.push(`- **前情已谈定**：${p.preset_elements.join('、')}`);
  out.push('');

  out.push(`### 暗牌 ${cards.length} 张（来自素材 ${cards.length - invented}、补写 ${invented}）`);
  out.push('');
  out.push('| 牌 | 买家藏着什么 | 业务员要问到什么 | 前置 | 出处 |');
  out.push('|---|---|---|---|---|');
  for (const [k, c] of cards) {
    const src = quotes.get(k);
    const from = !src ? '（没交代）' : src.invented ? `补写：${esc(src.why)}` : `第 ${src.message_index} 条：「${esc(src.quote)}」`;
    out.push(`| ${k} | ${esc(c.value)} | ${esc(c.unlock)} | ${((c.requires as string[]) ?? []).join('、') || '—'} | ${from} |`);
  }
  out.push('');

  if (p.distractors?.length) {
    out.push('### 干扰项');
    out.push('');
    for (const d of p.distractors as Record<string, unknown>[]) out.push(`- 第 ${(d.turn_range as number[]).join('–')} 轮：「${esc(d.content)}」——${esc(d.tests)}`);
    out.push('');
  }

  out.push('### 买家的固定回复');
  out.push('');
  const qr = p.quote_reactions as Record<string, string | null>;
  out.push(`- 报价规范：${esc(qr.compliant)}`);
  out.push(`- 没确认数量就报价（R1）：${esc(qr.redline_R1)}`);
  out.push(`- 报价数量对不上：${esc(qr.qty_mismatch)}`);
  out.push(`- 大单只回一句话报价：${esc(qr.oneline_big_quote)}`);
  out.push(`- 问不到点子上：${esc(p.leak_fallback)}`);
  out.push(`- 聊满轮数：${esc(p.exit_lines.maxTurns)}`);
  out.push('');

  if (q.bg) {
    const ar = (q.bg.ai_report ?? {}) as { content?: string; planted_error?: { claim?: string; truth?: string; detectable_via?: string[] } };
    out.push('### 背调包');
    out.push('');
    out.push(`- **AI 报告（新人看到的）**：${esc(ar.content)}`);
    out.push(`- **预埋错误**：报告说「${esc(ar.planted_error?.claim)}」，真相是「${esc(ar.planted_error?.truth)}」`);
    out.push(`- **识破路径**：${(ar.planted_error?.detectable_via ?? []).join('、')}`);
    for (const sec of ['website', 'social', 'contacts'] as const) {
      const hint = JSON.stringify(q.bg[sec] ?? {}).match(/"_cross_check_hint":"([^"]*)"/g)?.map((h) => h.replace(/^"_cross_check_hint":"|"$/g, ''));
      if (hint?.length) out.push(`- **${sec} 里的矛盾**：${hint.map(esc).join('；')}`);
    }
    out.push('');
  }

  if (warn.length) {
    out.push('### 机器提醒');
    out.push('');
    for (const x of warn) out.push(`- ⚠ ${x.what}`);
    out.push('');
  }

  out.push('### 机器看不出来、请你看');
  out.push('');
  out.push(`- [ ] 这个买家像真人吗？说话风格和国家、身份对得上吗？`);
  out.push(`- [ ] 暗牌考的是「${p.skeleton.name}」该考的东西吗？（考纲：${t?.tests ?? ''}）`);
  out.push(`- [ ] 补写的暗牌合理吗？有没有编得离谱的？`);
  out.push(`- [ ] 报价反应的意思对吗？「R1」那句应当是买家被没确认数量就报价时的冷淡反应。`);
  if (q.bg) out.push(`- [ ] 背调包的预埋错误够不够隐蔽？三块材料里的矛盾，新人认真核对能不能发现？`);
  out.push('');

  if (m && q.kind === 'mother') {
    out.push('<details><summary>素材原文（已脱敏）</summary>');
    out.push('');
    let last: string | null = null;
    m.chat.messages.forEach((x, i) => {
      if (x.date && x.date !== last) {
        out.push(`\n**${x.date}**\n`);
        last = x.date;
      }
      out.push(`${i}. ${x.side === 'client' ? '买家' : '业务员'}：${esc(x.text)}  `);
    });
    out.push('');
    out.push('</details>');
    out.push('');
  }

  if (card) {
    out.push(`**怎么答**：\`npm run drawer -- answer ${it.materialId.replace(/-m\d+$/, '')} ${card.id} accept\`（采用）｜\`revise\`（退回修订）｜\`reject\`（弃用）｜\`other 你的修改意见\``);
    out.push('');
  }
  return out.join('\n');
}

export function reviewSheet(store: Store, batchId: string): { markdown: string; count: number } {
  const b = store.getBatch(batchId);
  const reviews = store.listReviews(batchId);
  const pending = new Map(reviews.filter((c) => !c.answer && c.kind === 'use_question').map((c) => [c.qid, c]));
  const parts: string[] = [];
  const rows: string[] = [];
  let n = 0;
  for (const id of b.items) {
    const it = store.getItem(batchId, id);
    const m = store.getMaterial<Material>(batchId, it.materialId);
    for (const q of it.questions) {
      if (q.status !== 'awaiting_review') continue;
      n += 1;
      const card = pending.get(q.qid);
      const mother = q.kind === 'variant' ? it.questions.find((x) => x.qid === q.parent)?.persona : undefined;
      const re = runGates(q.persona, q.kind === 'mother' && m ? { text: m.chat.messages.map((x) => x.text), textCn: m.chat.messages.map((x) => x.textCn ?? '') } : null, b.products as never);
      const hard = re.problems.filter((x) => x.level === '✗').length + (mother ? checkVariant(mother, q.persona).filter((x) => x.level === '✗').length : 0);
      rows.push(`| ${n} | ${q.qid} | ${q.persona.skeleton.name} | ${q.persona.pool_type === 'drill' ? '演习' : '考试'} | ${String(q.persona.open_card.country)} | ${card?.id ?? '—'} | ${hard ? `✗ ${hard}` : '✓'} |`);
      parts.push(section(n, it, q, card, q.kind === 'mother' ? m : null, b.products, mother));
    }
  }
  const head = [
    `# 审题单 · 批次 ${batchId}`,
    '',
    `生成于 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}（UTC）｜ 待确认 ${n} 道 ｜ 已花 ${b.usage.costCny} 元、调用 ${b.usage.calls} 次`,
    '',
    '「复查」一列是按当前版本的闸门重新跑一遍的结果（不花钱）。✗ 表示闸门升级后发现了新问题，建议选「退回修订」。',
    '',
    '| # | 题号 | 题型 | 题池 | 买家国家 | 确认卡 | 复查 |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '---',
    '',
  ];
  return { markdown: [...head, parts.join('\n---\n\n')].join('\n'), count: n };
}
