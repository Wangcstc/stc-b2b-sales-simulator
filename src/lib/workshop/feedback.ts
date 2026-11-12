/**
 * 回流（需求文档 6.7、阶段 6）：每道题在实战里表现怎么样，表现异常的出「回炉建议」，主管用选择题拍板。
 *
 *   6.1 实战统计：通过率、平均分、红线率、客户放弃率、最弱的力、常被漏掉的暗牌、是不是总被同一句话破解
 *   6.2 回炉建议：太容易 / 太难 / 被套话破解 → 回炉（退回抽屉照着统计改一版）/ 降为演习 / 下架 / 保留
 *
 * ★ 只出建议，不自动改题 ★ 口径在标准层 `feedback-rules.json`；每道题攒够一批有分的局才判，
 * 主管拍过板的同一条建议，要再攒够一批新局才会再提。
 *
 * ★ 同一道题跨版本合并算，改过内容的不合并 ★ 题按「题库号 + 题目编号」认；回炉后暗牌变了，
 * 旧局的数据说的是旧题，不能算到新题头上——只合并暗牌一模一样的那些版本。
 */
import { canRework, rework, similarity } from '../../../drawer/index';
import { FORCE_LABEL, type Force } from '../../../engine/types';
import { FEEDBACK_RULES, type FeedbackRules } from '../../../standards/index';
import { audit } from '../admin-audit';
import type { CurrentUser } from '../current-user';
import { prisma } from '../db';
import { workshopMode } from './mode';
import { startRun } from './runner';
import { workshopStore } from './service';

/* ═══════════ 纯计算（单测覆盖） ═══════════ */

export interface SessionRow {
  mode: string;
  /** 最终局分；没出分（样本不够精确）为 null */
  score: number | null;
  redlines: string[];
  exitReason: string | null;
  forces: Partial<Record<Force, number | null>>;
  /** 挖出来的暗牌，和挖出它的那句话（找不到为 null） */
  unlocked: { key: string; phrase: string | null }[];
}

export interface QuestionInfo {
  rowId: string;
  bankId: string;
  variantId: string;
  typeName: string;
  pool: 'drill' | 'exam';
  cards: string[];
  activeForces: Force[];
}

export interface QuestionStats extends QuestionInfo {
  sessions: number;
  scored: number;
  passRate: number | null;
  avgScore: number | null;
  redlineRate: number | null;
  gaveUpRate: number | null;
  weakestForce: { force: Force; label: string; avg: number } | null;
  cardRates: { key: string; rate: number }[];
  /** 挖出率低于口径的暗牌：常见失分点 */
  rareCards: { key: string; rate: number }[];
  /** 被套话破解：某张暗牌的解锁里同一句话占了大头 */
  onePhrase: { key: string; phrase: string; share: number; unlocks: number } | null;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function questionStats(info: QuestionInfo, rows: SessionRow[], rules: FeedbackRules = FEEDBACK_RULES): QuestionStats {
  const scored = rows.filter((r) => r.score !== null);
  const ended = rows.length;
  const weakest = info.activeForces
    .map((f) => ({ force: f, avg: avg(scored.map((r) => r.forces[f]).filter((x): x is number => typeof x === 'number')) }))
    .filter((x): x is { force: Force; avg: number } => x.avg !== null)
    .sort((a, b) => a.avg - b.avg)[0];
  const cardRates = info.cards.map((key) => ({ key, rate: ended ? rows.filter((r) => r.unlocked.some((u) => u.key === key)).length / ended : 0 }));

  // 被套话破解：同一张暗牌的解锁话术里，找出最大的一簇近似说法（相似度 ≥ 0.8 算一句）
  let onePhrase: QuestionStats['onePhrase'] = null;
  for (const key of info.cards) {
    const said = rows.flatMap((r) => r.unlocked.filter((u) => u.key === key && u.phrase).map((u) => u.phrase!.trim()));
    const phrases = said.map(norm);
    if (phrases.length < rules.one_phrase_min_unlocks) continue;
    let best = { phrase: '', n: 0 };
    phrases.forEach((p, i) => {
      const n = phrases.filter((q) => q === p || similarity(p, q) >= 0.8).length;
      // 比较用规范化的，给人看用业务员的原话
      if (n > best.n) best = { phrase: said[i]!, n };
    });
    const share = best.n / phrases.length;
    if (share >= rules.one_phrase_share && (!onePhrase || share > onePhrase.share)) onePhrase = { key, phrase: best.phrase, share, unlocks: phrases.length };
  }

  return {
    ...info,
    sessions: ended,
    scored: scored.length,
    passRate: scored.length ? scored.filter((r) => r.score! >= rules.pass_score).length / scored.length : null,
    avgScore: avg(scored.map((r) => r.score!)),
    redlineRate: ended ? rows.filter((r) => r.redlines.length > 0).length / ended : null,
    gaveUpRate: ended ? rows.filter((r) => r.exitReason === 'patienceZero' || r.exitReason === 'stagnant').length / ended : null,
    weakestForce: weakest ? { force: weakest.force, label: FORCE_LABEL[weakest.force], avg: weakest.avg } : null,
    cardRates,
    rareCards: ended >= rules.min_sessions ? cardRates.filter((c) => c.rate < rules.rare_card_unlock_rate) : [],
    onePhrase,
  };
}

export type SuggestionKind = 'too_easy' | 'too_hard' | 'one_phrase';
export type Decision = 'rework' | 'to_drill' | 'retire' | 'keep' | 'other';

export interface SuggestionOption {
  key: Decision;
  label: string;
  effect: string;
  recommended?: boolean;
}

export interface Suggestion {
  kind: SuggestionKind;
  stats: QuestionStats;
  question: string;
  reason: string;
  /** 交给模型的修改意见（选「回炉」时用；「其他」写的话会接在后面） */
  reworkNote: string;
  options: SuggestionOption[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * 出建议。opts.canRework：这道题能不能退回抽屉改（是抽屉做的、而且在常驻服务器上）；
 * opts.decided：主管对这道题拍过的板（同一类建议要再攒够 min_sessions 局新数据才再提）。
 */
export function suggestionsFor(
  s: QuestionStats,
  opts: { canRework: boolean; decided: { kind: string; sessionsAtDecision: number }[] },
  rules: FeedbackRules = FEEDBACK_RULES,
): Suggestion[] {
  if (s.scored < rules.min_sessions && !s.onePhrase) return [];
  const fresh = (kind: SuggestionKind) => !opts.decided.some((d) => d.kind === kind && s.scored - d.sessionsAtDecision < rules.min_sessions);
  const base = `最近 ${s.scored} 局有分的局里 ${Math.round((s.passRate ?? 0) * s.scored)} 局过了 ${rules.pass_score} 分（通过率 ${pct(s.passRate ?? 0)}），平均 ${Math.round(s.avgScore ?? 0)} 分`;
  const out: Suggestion[] = [];

  const build = (kind: SuggestionKind, reason: string, note: string, reworkLabel: string, order: Decision[]): Suggestion => {
    const all: Record<Decision, SuggestionOption> = {
      rework: { key: 'rework', label: reworkLabel, effect: '模型照着这份统计改一版（约 0.3 元），改完到「确认」页等你；采用后下次打包顶替这道题，编号不变' },
      to_drill: { key: 'to_drill', label: '降为演习题', effect: '马上生效：不再出现在考试里，演习照常能练；下次打包带过去' },
      retire: { key: 'retire', label: '下架', effect: '马上生效：不再出现在题池里；打过的局、报告照常能打开' },
      keep: { key: 'keep', label: '保留', effect: `不动它；再攒 ${rules.min_sessions} 局新数据前不再提醒` },
      other: { key: 'other', label: '其他', effect: '' },
    };
    const actions = order.filter((k) => (k !== 'rework' || opts.canRework) && (k !== 'to_drill' || s.pool === 'exam')).slice(0, 2);
    const options = [...actions, 'keep' as const].map((k, i) => ({ ...all[k], ...(i === 0 ? { recommended: true } : {}) }));
    return { kind, stats: s, question: '', reason, reworkNote: note, options: [...options, all.other] };
  };

  if (s.scored >= rules.min_sessions && s.passRate !== null && s.passRate >= rules.too_easy_pass_rate && fresh('too_easy')) {
    const sug = build(
      'too_easy',
      `${base}，太容易了：这道题已经分不出谁会谁不会。`,
      `实战 ${s.scored} 局里通过率 ${pct(s.passRate)}，太容易。请提高难度：让关键暗牌更难挖（要靠结合上下文追问才解锁，一句常见问法开不了），或者加一张干扰暗牌；题型、考点、买家身份不变。`,
      '回炉：加难度',
      ['rework', 'to_drill', 'retire'],
    );
    sug.question = `${s.variantId}（${s.typeName}）太容易了，怎么办？`;
    out.push(sug);
  }
  if (s.scored >= rules.min_sessions && s.passRate !== null && s.passRate <= rules.too_hard_pass_rate && fresh('too_hard')) {
    const rare = s.rareCards[0];
    const sug = build(
      'too_hard',
      `${base}，太难了${rare ? `：暗牌 ${rare.key} 只有 ${pct(rare.rate)} 的局挖了出来` : ''}${s.weakestForce ? `；大家丢分最多的是${s.weakestForce.label}（平均 ${s.weakestForce.avg.toFixed(1)} 分）` : ''}。`,
      `实战 ${s.scored} 局里通过率只有 ${pct(s.passRate)}，太难。${rare ? `暗牌 ${rare.key} 只有 ${pct(rare.rate)} 的局挖了出来：` : ''}请让关键信息更好挖——补几种更自然的解锁说法，买家被问到相关话题时给出线索；红线要求不放松，题型、考点不变。`,
      '回炉：降一点难度',
      ['rework', 'to_drill', 'retire'],
    );
    sug.question = `${s.variantId}（${s.typeName}）太难了，怎么办？`;
    out.push(sug);
  }
  if (s.onePhrase && fresh('one_phrase')) {
    const p = s.onePhrase;
    const sug = build(
      'one_phrase',
      `暗牌 ${p.key} 被挖出的 ${p.unlocks} 次里，有 ${pct(p.share)} 用的是同一句话「${p.phrase.slice(0, 60)}」——这张牌被套话破解了，考不出真本事。`,
      `暗牌 ${p.key} 的解锁里 ${pct(p.share)} 都是同一句话「${p.phrase.slice(0, 60)}」，被套话破解。请改写这张暗牌的解锁条件：要业务员结合买家前面说的话追问才解锁，并补几种不同说法的解锁正则；其余不变。`,
      '回炉：改这张暗牌的解锁条件',
      ['rework', 'retire', 'to_drill'],
    );
    sug.question = `${s.variantId}（${s.typeName}）总被同一句话破解，怎么办？`;
    out.push(sug);
  }
  return out;
}

/* ═══════════ 读库 ═══════════ */

export interface FeedbackView {
  version: { bankId: string; bankVersion: string } | null;
  stats: QuestionStats[];
  suggestions: Suggestion[];
  rules: FeedbackRules;
  canReworkAny: boolean;
}

export async function feedbackView(): Promise<FeedbackView> {
  const cur = await prisma.bankVersion.findFirst({ where: { isCurrent: true }, select: { id: true, bankId: true, bankVersion: true } });
  if (!cur) return { version: null, stats: [], suggestions: [], rules: FEEDBACK_RULES, canReworkAny: false };
  const rows = await prisma.personaVariant.findMany({
    where: { bankVersionId: cur.id, enabledInBank: true },
    select: { id: true, variantId: true, poolType: true, hiddenCard: true, persona: { select: { code: true, name: true, activeForces: true } } },
  });
  // 同一道题的其他版本：暗牌一模一样的才合并统计
  const siblings = await prisma.personaVariant.findMany({
    where: { variantId: { in: rows.map((r) => r.variantId) }, bankVersion: { bankId: cur.bankId } },
    select: { id: true, variantId: true, hiddenCard: true },
  });
  const rowIdsOf = new Map<string, string[]>();
  for (const r of rows) {
    const h = JSON.stringify(r.hiddenCard);
    rowIdsOf.set(r.id, siblings.filter((x) => x.variantId === r.variantId && JSON.stringify(x.hiddenCard) === h).map((x) => x.id));
  }
  const allIds = [...new Set([...rowIdsOf.values()].flat())];
  const sessions = await prisma.session.findMany({
    where: { variantId: { in: allIds }, status: 'ENDED' },
    select: { id: true, variantId: true, mode: true, exitReason: true, facts: true, score: { select: { rawScore: true, forces: true } } },
  });
  const trainee = await prisma.message.findMany({
    where: { sessionId: { in: sessions.map((s) => s.id) }, role: 'trainee' },
    select: { sessionId: true, turn: true, content: true },
  });
  const said = new Map(trainee.map((m) => [`${m.sessionId}#${m.turn}`, m.content]));
  const toRow = (s: (typeof sessions)[number]): SessionRow => {
    const f = (s.facts ?? {}) as { redlines?: string[]; unlockedCards?: { key: string; turn: number }[] };
    const forces = Object.fromEntries(
      Object.entries((s.score?.forces ?? {}) as Record<string, { score?: unknown }>).map(([k, v]) => [k, typeof v?.score === 'number' ? v.score : null]),
    ) as SessionRow['forces'];
    return {
      mode: s.mode,
      score: s.score?.rawScore ?? null,
      redlines: f.redlines ?? [],
      exitReason: s.exitReason,
      forces,
      unlocked: (f.unlockedCards ?? []).map((u) => ({ key: u.key, phrase: said.get(`${s.id}#${u.turn}`) ?? null })),
    };
  };
  const decisions = await prisma.questionFeedback.findMany({ where: { bankId: cur.bankId }, select: { variantId: true, kind: true, sessionsAtDecision: true } });
  const full = workshopMode() === 'full';
  const store = full ? workshopStore() : null;

  const stats: QuestionStats[] = [];
  const suggestions: Suggestion[] = [];
  for (const r of rows) {
    const ids = new Set(rowIdsOf.get(r.id));
    const info: QuestionInfo = {
      rowId: r.id,
      bankId: cur.bankId,
      variantId: r.variantId,
      typeName: `${r.persona.code} ${r.persona.name}`,
      pool: r.poolType === 'DRILL' ? 'drill' : 'exam',
      cards: Object.keys((r.hiddenCard ?? {}) as Record<string, unknown>).filter((k) => !k.startsWith('_')),
      activeForces: ((r.persona.activeForces ?? []) as Force[]).filter((x) => x in FORCE_LABEL),
    };
    const st = questionStats(info, sessions.filter((s) => ids.has(s.variantId)).map(toRow));
    stats.push(st);
    let reworkable = false;
    try {
      reworkable = Boolean(store && canRework(store, cur.bankId, r.variantId));
    } catch {
      reworkable = false;
    }
    suggestions.push(...suggestionsFor(st, { canRework: reworkable, decided: decisions.filter((d) => d.variantId === r.variantId) }));
  }
  stats.sort((a, b) => b.sessions - a.sessions || a.variantId.localeCompare(b.variantId));
  return { version: { bankId: cur.bankId, bankVersion: cur.bankVersion }, stats, suggestions, rules: FEEDBACK_RULES, canReworkAny: full };
}

/* ═══════════ 拍板 ═══════════ */

export async function decideFeedback(
  user: CurrentUser,
  input: { variantId: string; kind: SuggestionKind; option: Decision; text?: string },
): Promise<string> {
  const view = await feedbackView();
  const sug = view.suggestions.find((s) => s.stats.variantId === input.variantId && s.kind === input.kind);
  if (!sug || !view.version) throw new Error('这条建议已经处理过，或者数据变了：刷新页面再看');
  if (!sug.options.some((o) => o.key === input.option)) throw new Error(`这条建议没有选项「${input.option}」`);
  if (input.option === 'other' && !input.text?.trim()) throw new Error('选「其他」要写下你的意见');
  const row = sug.stats.rowId;
  let say: string;

  if (input.option === 'rework') {
    const store = workshopStore();
    const note = `${sug.reworkNote}${input.text?.trim() ? `\n主管补充：${input.text.trim()}` : ''}`;
    const hit = rework(store, view.version.bankId, input.variantId, note);
    if (!hit) throw new Error('抽屉工作区里找不到这道题（不是题库工坊做的题），回炉不了；可以选降为演习或下架');
    startRun(store, hit.batchId);
    say = '已退回抽屉修订，改完到「确认」页等你';
  } else if (input.option === 'to_drill') {
    await prisma.personaVariant.update({ where: { id: row }, data: { poolType: 'DRILL', examOnly: false } });
    say = '已降为演习题';
  } else if (input.option === 'retire') {
    await prisma.personaVariant.update({ where: { id: row }, data: { enabledInBank: false, active: false } });
    say = '已下架';
  } else say = input.option === 'keep' ? '保留' : '记下了你的意见，题先不动';

  await prisma.questionFeedback.create({
    data: {
      bankId: view.version.bankId,
      variantId: input.variantId,
      kind: input.kind,
      decision: input.option,
      note: input.text?.trim() || null,
      sessionsAtDecision: sug.stats.scored,
      decidedById: user.id,
    },
  });
  await audit({ actorId: user.id, action: 'FEEDBACK_DECIDE', after: `${input.variantId}：${sug.question} → ${sug.options.find((o) => o.key === input.option)?.label}`, note: input.text?.trim() || null });
  return say;
}
