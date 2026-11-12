/**
 * 抽屉的流水线：投料 → 脱敏 → 归型 → 起草 → 质检校准 → 主管确认 → 变体 → 分池 → 打包。
 *
 * ★ 每一步都落盘 ★ 状态写在 `workspace/drawer/batches/<批次>/`，`run` 随时可以中断、随时可以重跑，
 * 重跑只做还没做完的事，已经花过钱的步骤不会再花一次。
 * ★ 要主管拍板的事一律做成选择题卡 ★ 3 个选项 + 「其他」，推荐项排第一并写明理由。
 * 卡没答之前，相关素材停在原地，其他素材照常往下走。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  BG_SYSTEM,
  DRAFT_SYSTEM,
  REVISE_SYSTEM,
  TRIAGE_SYSTEM,
  VARIANT_SYSTEM,
  syllabusType,
  type Difficulty,
  type SyllabusType,
} from '../standards/index';
import {
  canonicalCountry,
  countryCode,
  examReadiness,
  examSlotOf,
  readBank,
  validateBank,
  writeBank,
  type BgPackage,
  type Manifest,
  type Persona,
  type SlotReadiness,
} from '../bank-kit/index';
import { SIX_ELEMENTS } from '../engine/types.js';
import { parseChatFile, type RawChat } from './ingest/chat-parse';
import { createRedactor } from './ingest/chat-redact';
import { catalogToProduct, readCompanySheet, readProductSheet, type CatalogEntry } from './materials';
import { bgPrompt, draftPrompt, parseJsonObject, revisePrompt, triagePrompt, variantPrompt } from './prompt-build';
import { hardCount, runGates } from './qa/gate';
import { checkVariant } from './qa/variant';
import { checkBgPackage } from './qa/bg';
import type { Material } from './qa/fidelity';
import { costOf, estimateBatch, type Estimate } from './cost';
import type { Llm, LlmRequest } from './llm';
import type { Problem } from './qa/regex';
import { Store } from './store';
import { personaChanges } from './diff';
import {
  DEFAULT_CONFIG,
  type Batch,
  type BatchConfig,
  type ChoiceOption,
  type Item,
  type Question,
  type ReviewCard,
  type TriageResult,
} from './types';

export const DRAWER_VERSION = '8.4.0';

const now = () => new Date().toISOString();
const pad = (n: number, w = 3) => String(n).padStart(w, '0');
const log = (b: Batch, msg: string) => b.log.push({ at: now(), msg });

interface RedactedMaterial {
  material_id: string;
  digest: Record<string, unknown>;
  audit: unknown[];
  chat: RawChat;
}

/* ═══════════════════ ① 投料 ═══════════════════ */

export function createBatch(store: Store, id?: string, config: Partial<BatchConfig> = {}): Batch {
  const batchId = id ?? `batch-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(2).toString('hex')}`;
  if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(batchId)) throw new Error(`批次号「${batchId}」只能用小写字母、数字和连字符`);
  if (store.hasBatch(batchId)) return store.getBatch(batchId);
  const b: Batch = {
    id: batchId,
    createdAt: now(),
    config: { ...DEFAULT_CONFIG, ...config },
    status: 'open',
    items: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, costCny: 0 },
    log: [],
  };
  log(b, '建立批次');
  store.saveBatch(b);
  return b;
}

function expand(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const abs = resolve(p);
    if (!statSync(abs).isDirectory()) out.push(abs);
    // 一个目录里有 redacted.json，就当它是一份已脱敏的素材
    else if (existsSync(join(abs, 'redacted.json'))) out.push(join(abs, 'redacted.json'));
    else for (const f of readdirSync(abs).sort()) out.push(join(abs, f));
  }
  return out;
}

export interface IngestReport {
  chats: number;
  duplicates: number;
  products: number | null;
  company: boolean;
  ignored: string[];
  /** 其中已经脱敏过的素材份数 */
  preRedacted?: number;
}

/**
 * 收原材料：聊天导出件（.html）复制进批次的收件箱；产品表、公司信息表（.xlsx）当场解析。
 * ★ 只复制，不动你原来的文件 ★ 收件箱里的副本在脱敏通过后默认删除（批次设置 keepRaw 可保留）。
 */
export async function ingest(store: Store, batchId: string, paths: string[]): Promise<IngestReport> {
  const b = store.getBatch(batchId);
  const report: IngestReport = { chats: 0, duplicates: 0, products: null, company: false, ignored: [] };
  const known = new Set(b.items.map((id) => store.getItem(batchId, id).file));
  mkdirSync(store.inboxDir(batchId), { recursive: true });
  for (const f of expand(paths)) {
    const name = basename(f);
    const ext = extname(f).toLowerCase();
    if (name === 'redacted.json') {
      // 已经脱敏过的素材（`npm run import:chat` 的产物）：不再脱敏，直接进加工
      const label = `${basename(join(f, '..'))}.redacted.json`;
      if (known.has(label)) {
        report.duplicates += 1;
        continue;
      }
      const src = JSON.parse(readFileSync(f, 'utf8')) as Partial<RedactedMaterial>;
      if (!src.chat?.messages?.length) {
        report.ignored.push(`${label}（不是脱敏素材）`);
        continue;
      }
      // 已脱敏的素材也要补跑一遍当前的脱敏规则（只跑模式规则与本批词表，名字早已是化名）：旧版脱敏漏掉的东西（货件号、自家品牌）这里补上
      copyFileSync(f, join(store.inboxDir(batchId), label));
      const n = b.items.length + 1;
      const item: Item = { id: `i${pad(n)}`, file: label, status: 'received', materialId: `${batchId}-m${pad(n)}`, questions: [], extraTerms: [], attempts: 0, preRedacted: true };
      b.items.push(item.id);
      known.add(label);
      store.saveItem(batchId, item);
      report.chats += 1;
      report.preRedacted = (report.preRedacted ?? 0) + 1;
    } else if (ext === '.html' || ext === '.htm') {
      // 「_副本」「(1)」这类重复导出件去掉，同一份对话导两遍没意义
      if (/_副本\d*\.html?$/i.test(name) || / \(\d+\)\.html?$/i.test(name) || known.has(name)) {
        report.duplicates += 1;
        continue;
      }
      copyFileSync(f, join(store.inboxDir(batchId), name));
      const n = b.items.length + 1;
      const item: Item = {
        id: `i${pad(n)}`,
        file: name,
        status: 'received',
        materialId: `${batchId}-m${pad(n)}`,
        questions: [],
        extraTerms: [],
        attempts: 0,
      };
      b.items.push(item.id);
      known.add(name);
      store.saveItem(batchId, item);
      report.chats += 1;
    } else if (ext === '.xlsx' && /产品/.test(name)) {
      b.products = (await readProductSheet(f)) as unknown as Record<string, unknown>[];
      report.products = b.products.length;
    } else if (ext === '.xlsx' && /公司/.test(name)) {
      b.company = await readCompanySheet(f);
      report.company = true;
    } else report.ignored.push(name);
  }
  log(b, `投料：聊天 ${report.chats} 份${report.products !== null ? `、产品 ${report.products} 个` : ''}${report.company ? '、公司信息' : ''}`);
  store.saveBatch(b);
  redactPending(store, batchId);
  return report;
}

/* ═══════════════════ ② 脱敏 ═══════════════════ */

function digest(chat: RawChat) {
  const client = chat.messages.filter((m) => m.side === 'client');
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  return {
    消息数: chat.messages.length,
    客户发言: client.length,
    我方发言: chat.messages.length - client.length,
    客户平均字数: client.length ? Math.round(client.reduce((a, m) => a + words(m.text), 0) / client.length) : 0,
    时间跨度: String(chat.header['时间范围'] ?? ''),
    是否成交: chat.order ? (chat.order.hasOrder ? '已成交' : '未成交') : '未知',
  };
}

/**
 * 把收件箱里待脱敏的素材全部过一遍。
 *
 * ★ 一个脱敏器按投料顺序跑完整批 ★ 化名是按出现顺序发的：同一个客户在不同文件里拿到同一个化名，
 * 而且某一份被卡住、主管确认后重跑时，拿到的化名和一次跑通时一模一样。所以重跑时前面已经通过的素材
 * 也要再过一遍脱敏器（结果不用，只为让化名顺序对齐），原始件因此要留到整批都过了脱敏才删。
 * 残留自检不过 = 硬失败；有疑似漏网的人名 = 停下来出一张选择题卡。
 */
export function redactPending(store: Store, batchId: string, cleanupOnly = false): void {
  const b = store.getBatch(batchId);
  const all = b.items.map((id) => store.getItem(batchId, id));
  if (!all.some((it) => it.status === 'received')) {
    if (cleanupOnly) cleanupRaw(store, b, all);
    return;
  }
  const extra = [...new Set([...(b.config.maskTerms ?? []), ...all.flatMap((it) => it.extraTerms)])];
  const redactor = createRedactor({ extraTerms: extra });
  for (const it of all) {
    const raw = join(store.inboxDir(batchId), it.file);
    const pending = it.status === 'received';
    if (!existsSync(raw)) {
      if (pending) {
        it.status = 'failed';
        it.reason = '收件箱里找不到原始导出件，请重新投料';
        store.saveItem(batchId, it);
      }
      continue;
    }
    try {
      const res = it.preRedacted
        ? redactor.redact((JSON.parse(readFileSync(raw, 'utf8')) as RedactedMaterial).chat, { patternsOnly: true })
        : redactor.redact(parseChatFile(raw));
      if (!pending) continue;
      if (res.residue.length) {
        it.status = 'failed';
        it.reason = `脱敏自检未通过（${res.residue.length} 处残留），已拦下，不进加工`;
      } else if (res.suspects.length && !it.allowSuspects) {
        it.status = 'blocked';
        it.reason = `有 ${res.suspects.length} 个疑似漏网的人名或公司名，等主管确认`;
        addCard(store, batchId, suspectCard(it, res.suspects));
      } else {
        const m: RedactedMaterial = { material_id: it.materialId, digest: digest(res.chat), audit: res.audit, chat: res.chat };
        store.saveMaterial(batchId, it.materialId, m);
        it.status = 'redacted';
        it.reason = undefined;
      }
    } catch (e) {
      if (!pending) continue;
      it.status = 'failed';
      it.reason = `解析失败：${(e as Error).message}`;
    }
    store.saveItem(batchId, it);
  }
  cleanupRaw(store, b, all);
}

/** 整批都过了脱敏（没有待脱敏、待确认的）才删原始件 */
function cleanupRaw(store: Store, b: Batch, all: Item[]) {
  if (b.config.keepRaw || all.some((it) => it.status === 'received' || it.status === 'blocked')) return;
  for (const it of all) store.removeFile(join(store.inboxDir(b.id), it.file));
}

/* ═══════════════════ 选择题卡 ═══════════════════ */

const OTHER: ChoiceOption = { key: 'other', label: '其他（写下你的意见）' };

function addCard(store: Store, batchId: string, card: Omit<ReviewCard, 'id' | 'createdAt'>): ReviewCard {
  const n = store.listReviews(batchId).length + 1;
  const full: ReviewCard = { ...card, id: `r${pad(n, 4)}`, createdAt: now() };
  store.saveReview(batchId, full);
  return full;
}

/**
 * 一眼就是噪音的词：贸易术语、认证与单证缩写、型号前缀（「LT-」这种）。
 * 疑似词**全部**落在这里时推荐「放行」；只要有一个不在，就推荐「全部抹掉」——宁可多抹，不能漏真名。
 */
const NOISE = /^(?:[A-Z]{1,4}-|FOB|EXW|CIF|CFR|DAP|DDP|FCA|MOQ|OEM|ODM|QC|AQL|PI|PO|BL|B\/L|TT|T\/T|LC|L\/C|USD|EUR|RMB|CNY|GBP|CE|FCC|ROHS|REACH|UKCA|UL|ETL|FDA|LFGB|MSDS|SDS|BSCI|ISO|SGS|TUV|TÜV|IPX\d|IP\d{2}|LED|USB|USB-C|PDF|ETA|ETD|DHL|UPS|FEDEX|TNT|EMS|HS|COO|FORM [AE]|SKU)$/i;

function suspectCard(it: Item, suspects: string[]): Omit<ReviewCard, 'id' | 'createdAt'> {
  const list = suspects.slice(0, 30);
  const allNoise = suspects.every((w) => NOISE.test(w.trim()));
  const options: ChoiceOption[] = [
    { key: 'mask_all', label: '全部当作人名或公司名抹掉，重新脱敏', effect: '这些词加进本批的脱敏词表，重跑脱敏' },
    { key: 'pass', label: '都是噪音（贸易术语、地名、产品词），原样放行', effect: '这份素材照常进入加工' },
    { key: 'drop', label: '这份素材不用了', effect: '标为不出题' },
  ];
  if (allNoise) [options[0], options[1]] = [options[1]!, options[0]!];
  options[0]!.recommended = true;
  return {
    kind: 'redact_suspect',
    itemId: it.id,
    question: `素材 ${it.materialId} 脱敏后还有 ${suspects.length} 个词长得像人名或公司名：${list.join('、')}${suspects.length > list.length ? '……' : ''}。怎么处理？`,
    reason: allNoise
      ? '这些词全是贸易术语、认证缩写或型号前缀，不是人名，放行不会漏真名。'
      : '正则抓不全正文里的人名，宁可多抹，也不能漏一个真名进题库。',
    options: [...options, { ...OTHER, label: '其他：写出要抹的词，用逗号隔开' }],
    batchable: false,
  };
}

const DIFFICULTY_CN: Record<string, string> = { simple_with_distractors: '简单', standard: '标准', hard: '困难' };

function questionCard(it: Item, q: Question, t: SyllabusType): Omit<ReviewCard, 'id' | 'createdAt'> {
  const warn = q.qa.filter((x) => x.level === '⚠');
  const p = q.persona;
  const cards = Object.keys(p.hidden_card).filter((k) => !k.startsWith('_')).length;
  const idx = q.calibration?.index;
  const facts = `${t.name}，${DIFFICULTY_CN[p.difficulty ?? p.skeleton.difficulty] ?? p.skeleton.difficulty}档，暗牌 ${cards} 张，机制难度指数 ${idx ?? '—'}，质检 0 个硬问题、${warn.length} 个提醒`;
  const accept = warn.length <= 2;
  const opts: ChoiceOption[] = [
    { key: 'accept', label: '采用', effect: q.kind === 'mother' && t.exam_eligible ? '进题库；并按这道题衍生考试变体' : '进题库' },
    { key: 'revise', label: '退回修订：让模型按质检提醒再改一版', effect: '花一次模型调用，改完重新质检、重新出卡' },
    { key: 'reject', label: '弃用', effect: '不进题库' },
  ];
  if (!accept) [opts[0], opts[1]] = [opts[1]!, opts[0]!];
  opts[0]!.recommended = true;
  return {
    kind: 'use_question',
    itemId: it.id,
    qid: q.qid,
    question: `${q.replaces ? `回炉题（替换题库里的 ${q.replaces}）` : q.kind === 'mother' ? '母题' : `变体（母题 ${q.parent}）`} ${q.qid}「${String(p.open_card.company)}」要不要采用？`,
    reason: accept
      ? `机器闸门全部通过：${facts}。${warn.length ? `提醒：${warn.map((w) => w.what).join('；')}` : ''}`
      : `机器闸门通过，但提醒偏多（${warn.length} 个），建议先修一版：${warn.slice(0, 4).map((w) => w.what).join('；')}`,
    options: [...opts, OTHER],
    // 演习题可以一页批量按推荐处理；考试题必须逐道确认
    batchable: p.pool_type === 'drill',
  };
}

function budgetCard(b: Batch): Omit<ReviewCard, 'id' | 'createdAt'> {
  return {
    kind: 'budget',
    question: `本批已花 ${b.usage.costCny.toFixed(2)} 元，到了预算 ${b.config.budgetCny} 元。接下来怎么办？`,
    reason: '已经做完的题不会丢；追加预算后从断点接着跑，不会重复花钱。',
    options: [
      { key: 'raise', label: `预算翻倍到 ${b.config.budgetCny * 2} 元，接着跑`, recommended: true },
      { key: 'stop_pack', label: '停在这里，先把已确认的题打包' },
      { key: 'stop', label: '停止这一批' },
      { ...OTHER, label: '其他：写一个新的预算金额（元）' },
    ],
    batchable: false,
  };
}

/* ═══════════════════ 模型调用（记账 + 预算闸） ═══════════════════ */

class BudgetPaused extends Error {}

async function call(store: Store, b: Batch, llm: Llm, req: LlmRequest): Promise<Record<string, unknown>> {
  if (b.config.budgetCny > 0 && b.usage.costCny >= b.config.budgetCny) throw new BudgetPaused();
  const r = await llm.complete(req);
  b.usage.calls += 1;
  b.usage.inputTokens += r.inputTokens;
  b.usage.outputTokens += r.outputTokens;
  b.usage.costCny = Math.round((b.usage.costCny + costOf(r.model, r.inputTokens, r.outputTokens, new Date())) * 10000) / 10000;
  store.saveBatch(b);
  return parseJsonObject(r.text);
}

/* ═══════════════════ 组装一道题 ═══════════════════ */

const PASS_THROUGH = [
  'open_card', 'hidden_card', 'leak_fallback', 'distractors', 'customs_capability', 'init_state', 'rules_override',
  'exit_lines', 'quote_reactions', 'followup_reactions', 'language_style', 'preset_elements', 'verify_cases',
] as const;

/**
 * 模型常把正则写成 JS 字面量 `/…/i`。引擎按纯字符串编译（不区分大小写），斜杠会被当成要匹配的字符，
 * 整张牌永远解不开。这里在代码里确定性地剥掉，不指望模型每次都记得。
 */
const JS_LITERAL = /^\/(.+)\/[a-z]*$/s;
export function normalizePatterns(hidden: unknown): unknown {
  if (!hidden || typeof hidden !== 'object') return hidden;
  const out: Record<string, unknown> = {};
  for (const [k, card] of Object.entries(hidden as Record<string, unknown>)) {
    if (k.startsWith('_') || !card || typeof card !== 'object') {
      out[k] = card;
      continue;
    }
    const c = { ...(card as Record<string, unknown>) };
    for (const g of ['unlock_patterns', 'unlock_patterns_topic', 'unlock_patterns_framing']) {
      // JS 字面量 /…/i → 纯字符串；开头的内联标志 (?i) JS 不认，编译直接报错（引擎本来就不区分大小写）
      if (Array.isArray(c[g])) c[g] = (c[g] as unknown[]).map((x) => (typeof x === 'string' ? x.trim().replace(JS_LITERAL, '$1').replace(/^\(\?[a-z]+\)/i, '') : x));
    }
    // 泄露信号按字面子串匹配：模型常把 + . ( 这类字符转义成 \+，那样永远匹配不上
    if (Array.isArray(c.leak_signals)) c.leak_signals = (c.leak_signals as unknown[]).map((x) => (typeof x === 'string' ? x.replace(/\\([^A-Za-z0-9\s])/g, '$1') : x));
    out[k] = c;
  }
  return out;
}

/** 对一道已经组装好的题再规范化一遍（幂等）：闸门升级后重查老题时用，免得为了格式小毛病花钱修订 */
export function normalizePersona(p: Persona): Persona {
  const out = structuredClone(p) as Persona & Record<string, unknown>;
  out.hidden_card = normalizePatterns(out.hidden_card) as Persona['hidden_card'];
  if (out.skeleton.session_type === 'inquiry') {
    delete out.preset_elements;
    delete out.followup_reactions;
  } else if (Array.isArray(out.preset_elements)) out.preset_elements = normalizePreset(out.preset_elements) as string[];
  return out;
}

/** 「quantity: 300 pcs」→「quantity」；认不出代码的原样留下，交给质检报错，让模型改 */
export function normalizePreset(items: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const x of items) {
    if (typeof x !== 'string') {
      out.push(x);
      continue;
    }
    const head = /^\s*([a-z_]+)\s*(?:[:：=-]|$)/i.exec(x)?.[1]?.toLowerCase();
    const v = head && (SIX_ELEMENTS as readonly string[]).includes(head) ? head : x;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

function catalogOf(b: Batch): CatalogEntry[] {
  return (b.products ?? []) as unknown as CatalogEntry[];
}

function assemble(
  out: Record<string, unknown>,
  t: SyllabusType,
  catalog: CatalogEntry[],
  base: { id: string; kind: 'mother' | 'variant'; parent?: string; materialId: string; product?: Persona['product']; tests?: string; difficulty?: Difficulty },
): Persona {
  const allowed = [t.default_difficulty, ...t.also_difficulties];
  const difficulty = base.difficulty ?? (allowed.includes(out.difficulty as Difficulty) ? (out.difficulty as Difficulty) : t.default_difficulty);
  let product = base.product;
  if (!product) {
    const entry = catalog.find((c) => c.sku === out.product_sku) ?? catalog.find((c) => c.model && c.model === out.product_sku);
    if (!entry) throw new Error(`模型选的产品编号「${String(out.product_sku)}」不在产品表里`);
    product = catalogToProduct(entry);
    const sur = out.product_surcharges;
    if (sur && typeof sur === 'object' && Object.keys(sur).length) product.surcharges = sur as Record<string, unknown>;
  }
  const p: Record<string, unknown> = {
    id: base.id,
    ...(base.parent ? { derived_from: base.parent } : {}),
    version: '1.0',
    skeleton: {
      type_code: t.code,
      name: t.name,
      session_type: t.session_type,
      difficulty,
      tests: base.tests ?? (typeof out.tests === 'string' && out.tests.trim() ? out.tests : t.tests),
      active_forces: t.active_forces,
      na_forces: t.na_forces,
    },
    pool_type: base.kind === 'mother' ? 'drill' : 'admission_exam',
    product,
  };
  for (const k of PASS_THROUGH) if (out[k] !== undefined && out[k] !== null) p[k] = out[k];
  if (p.open_card && typeof p.open_card === 'object') {
    const oc = { ...(p.open_card as Record<string, unknown>) };
    if (typeof oc.country === 'string') oc.country = canonicalCountry(oc.country);
    p.open_card = oc;
  }
  if (p.hidden_card) p.hidden_card = normalizePatterns(p.hidden_card);
  // 跟进局前情：只认六要素代码（模型常写成「quantity: 300 pcs」）；询盘局没有前情
  if (t.session_type === 'inquiry') {
    delete p.preset_elements;
    delete p.followup_reactions;
  } else if (Array.isArray(p.preset_elements)) {
    p.preset_elements = normalizePreset(p.preset_elements as unknown[]);
  }
  const cards = Object.keys((out.hidden_card ?? {}) as object).filter((k) => !k.startsWith('_'));
  const quotes =
    base.kind === 'variant'
      ? cards.map((card) => ({ card, invented: true, why: '通用变体：由母题改写，内容是设计出来的' }))
      : ((out.source_quotes ?? []) as Record<string, unknown>[]).map((q) => {
          const o: Record<string, unknown> = { card: q.card };
          if (q.invented) {
            o.invented = true;
            o.why = q.why ?? '';
          } else {
            o.message_index = typeof q.message_index === 'number' ? q.message_index : null;
            o.quote = q.quote ?? '';
          }
          return o;
        });
  p._source = { material_id: base.materialId, quotes };
  return p as unknown as Persona;
}

function materialOf(m: RedactedMaterial | null): Material | null {
  return m ? { text: m.chat.messages.map((x) => x.text), textCn: m.chat.messages.map((x) => x.textCn ?? '') } : null;
}

function allocateId(store: Store, typeCode: string, country: string): string {
  const cc = countryCode(country);
  return `${typeCode}-${cc}-${pad(store.nextSeq(`${typeCode}-${cc}`))}`;
}

/**
 * 质检 → 不过就修订，最多 maxAttempts 次。返回最后一版（过了是 awaiting_review，没过是 qa_failed）。
 */
async function gateAndRevise(
  store: Store,
  b: Batch,
  llm: Llm,
  q: Question,
  material: Material | null,
  t: SyllabusType,
  note?: string,
  mother?: Persona,
): Promise<void> {
  const catalog = catalogOf(b);
  q.persona = normalizePersona(q.persona);
  const gates = (p: Persona) => {
    const g = runGates(p, material, catalog);
    return mother ? { ...g, problems: [...g.problems, ...checkVariant(mother, p)] } : g;
  };
  let gate = gates(q.persona);
  let pendingNote = note;
  while ((hardCount(gate.problems) > 0 || pendingNote) && q.attempts < b.config.maxAttempts) {
    q.attempts += 1;
    const out = await call(store, b, llm, {
      purpose: 'revise',
      system: REVISE_SYSTEM,
      user: revisePrompt(q.persona, gate.problems, pendingNote, material).user,
      json: true,
      tag: q.qid,
    });
    pendingNote = undefined;
    try {
      q.persona = assemble({ ...out, source_quotes: out.source_quotes ?? q.persona._source?.quotes }, t, catalog, {
        id: q.qid,
        kind: q.kind,
        parent: q.parent,
        materialId: q.persona._source?.material_id ?? '',
        product: q.persona.product,
        // 母题的考点描述可以由修订改写（主管常要求改它）；变体的考点永远跟母题走
        tests: q.kind === 'mother' && typeof out.tests === 'string' && out.tests.trim() ? out.tests : q.persona.skeleton.tests,
        difficulty: q.persona.skeleton.difficulty,
      });
    } catch (e) {
      gate = { problems: [{ level: '✗', what: (e as Error).message }], index: null };
      continue;
    }
    gate = gates(q.persona);
  }
  q.qa = gate.problems;
  q.calibration = { index: gate.index, problems: gate.problems.filter((x) => x.level === '✗') };
  q.status = hardCount(gate.problems) === 0 ? 'awaiting_review' : 'qa_failed';
  q.revisionNote = undefined;
  if (q.status === 'awaiting_review' && t.needs_bg_package) await makeBg(store, b, llm, q);
}

/**
 * 背调包：题目过闸之后再写（题目修订过，旧包可能对不上，所以每次过闸都重写一份）。
 * 背调包自己过不了闸就重写，最多 maxAttempts 次；仍不过，这道题算不合格——缺背调包的身份存疑题，考点少一块。
 */
async function makeBg(store: Store, b: Batch, llm: Llm, q: Question): Promise<void> {
  let problems: Problem[] = [];
  for (let i = 0; i < b.config.maxAttempts; i += 1) {
    const out = await call(store, b, llm, { purpose: 'bg', system: BG_SYSTEM, user: bgPrompt(q.persona, problems).user, json: true, tag: `${q.qid}#bg` });
    // 编号以题目为准，模型写什么都覆盖掉
    const pkg: Record<string, unknown> = { version: '1.0', ...out, persona_id: q.qid };
    problems = checkBgPackage(pkg, q.persona);
    if (hardCount(problems) === 0) {
      q.bg = pkg;
      q.qa = [...q.qa, ...problems];
      return;
    }
  }
  q.bg = undefined;
  q.status = 'qa_failed';
  q.qa = [...q.qa, ...problems.map((x) => ({ ...x, what: `背调包：${x.what}` }))];
}

/* ═══════════════════ ③–⑧ 加工 ═══════════════════ */

export interface RunOptions {
  /** 最多处理几份素材（试跑用） */
  limit?: number;
  onProgress?: (msg: string) => void;
}

export interface RunReport {
  status: Batch['status'];
  processed: number;
  pendingReviews: number;
  usage: Batch['usage'];
}

async function triage(store: Store, b: Batch, llm: Llm, it: Item, m: RedactedMaterial): Promise<void> {
  const clientMsgs = m.chat.messages.filter((x) => x.side === 'client').length;
  if (clientMsgs < b.config.minClientMessages) {
    it.status = 'skipped';
    it.reason = `买家发言只有 ${clientMsgs} 条（门槛 ${b.config.minClientMessages} 条），信息不够出一道题`;
    return;
  }
  const out = await call(store, b, llm, { purpose: 'triage', system: TRIAGE_SYSTEM, user: triagePrompt(m.chat).user, json: true, tag: it.materialId });
  const tr: TriageResult = {
    type_code: String(out.type_code ?? ''),
    confidence: Number(out.confidence ?? 0),
    reason: String(out.reason ?? ''),
    candidates: Array.isArray(out.candidates) ? (out.candidates as TriageResult['candidates']) : [],
    alt_types: Array.isArray(out.alt_types) ? (out.alt_types as string[]) : [],
    new_type_suggestion: (out.new_type_suggestion as TriageResult['new_type_suggestion']) ?? null,
  };
  it.triage = tr;
  if (tr.new_type_suggestion?.name) log(b, `新增题型建议：${tr.new_type_suggestion.name}（${it.materialId}）——${tr.new_type_suggestion.reason}`);
  if (!syllabusType(tr.type_code)) {
    it.status = 'skipped';
    it.reason = tr.new_type_suggestion?.name ? `归不进现有题型，建议新增「${tr.new_type_suggestion.name}」（由主管决定）` : '归不进考纲里的任何一型';
  } else if (tr.confidence < b.config.minConfidence) {
    it.status = 'skipped';
    it.reason = `归型信心 ${tr.confidence}，低于门槛 ${b.config.minConfidence}：${tr.reason}`;
  } else it.status = 'triaged';
}

async function draft(store: Store, b: Batch, llm: Llm, it: Item, m: RedactedMaterial): Promise<void> {
  const t = syllabusType(it.triage!.type_code)!;
  const catalog = catalogOf(b);
  it.attempts += 1;
  const out = await call(store, b, llm, {
    purpose: 'draft',
    system: DRAFT_SYSTEM,
    user: draftPrompt(t, m.chat, it.triage!.candidates, catalog, b.company).user,
    json: true,
    tag: it.materialId,
  });
  let persona: Persona;
  try {
    const country = String((out.open_card as Record<string, unknown> | undefined)?.country ?? '');
    persona = assemble(out, t, catalog, { id: allocateId(store, t.code, country), kind: 'mother', materialId: it.materialId });
  } catch (e) {
    if (it.attempts >= b.config.maxAttempts) {
      it.status = 'failed';
      it.reason = `起草 ${it.attempts} 次都没成形：${(e as Error).message}`;
    }
    return;
  }
  const q: Question = { qid: persona.id, kind: 'mother', persona, status: 'qa_failed', qa: [], attempts: 0, reviewIds: [] };
  await gateAndRevise(store, b, llm, q, materialOf(m), t);
  it.questions.push(q);
  if (q.status === 'awaiting_review') {
    it.status = 'drafted';
    q.reviewIds.push(addCard(store, b.id, questionCard(it, q, t)).id);
  } else {
    it.status = 'failed';
    it.reason = `母题修订 ${q.attempts} 次仍有 ${hardCount(q.qa)} 个硬问题，见 items/${it.id}.json`;
  }
}

/** ⑤ 通用变体：母题采用后，能进考试的题型按设置衍生几道考试变体 */
async function variants(store: Store, b: Batch, llm: Llm, it: Item): Promise<void> {
  const mother = it.questions.find((q) => q.kind === 'mother')!;
  const t = syllabusType(mother.persona.skeleton.type_code)!;
  const have = it.questions.filter((q) => q.kind === 'variant').length;
  const used = it.questions.map((q) => String(q.persona.open_card.country));
  for (let i = have; i < b.config.variantsPerMother; i += 1) {
    const out = await call(store, b, llm, { purpose: 'variant', system: VARIANT_SYSTEM, user: variantPrompt(mother.persona, i, used).user, json: true, tag: `${mother.qid}#${i}` });
    let persona: Persona;
    try {
      const country = String((out.open_card as Record<string, unknown> | undefined)?.country ?? '');
      persona = assemble(out, t, catalogOf(b), {
        id: allocateId(store, t.code, country),
        kind: 'variant',
        parent: mother.qid,
        materialId: it.materialId,
        product: mother.persona.product,
        tests: mother.persona.skeleton.tests,
        difficulty: mother.persona.skeleton.difficulty,
      });
      // 跟进局前情跟着母题走：同一个考点、同一段前情，模型漏写就沿用母题的
      if (t.session_type === 'followup' && !persona.preset_elements?.length && mother.persona.preset_elements?.length) {
        persona.preset_elements = [...mother.persona.preset_elements];
      }
    } catch (e) {
      log(b, `${mother.qid} 第 ${i + 1} 个变体没成形：${(e as Error).message}`);
      continue;
    }
    used.push(String(persona.open_card.country));
    const q: Question = { qid: persona.id, kind: 'variant', parent: mother.qid, persona, status: 'qa_failed', qa: [], attempts: 0, reviewIds: [] };
    await gateAndRevise(store, b, llm, q, null, t, undefined, mother.persona);
    it.questions.push(q);
    if (q.status === 'awaiting_review') q.reviewIds.push(addCard(store, b.id, questionCard(it, q, t)).id);
    store.saveItem(b.id, it);
  }
}

function needsVariants(b: Batch, it: Item): boolean {
  const mother = it.questions.find((q) => q.kind === 'mother');
  if (!mother || mother.status !== 'accepted') return false;
  const t = syllabusType(mother.persona.skeleton.type_code);
  // 变体与母题同档同局型：母题落不进任何考试槽位（简单档询盘局），变体也永远抽不到，不必花这份钱
  const slot = examSlotOf({ ...mother.persona, pool_type: 'admission_exam' });
  return Boolean(t?.exam_eligible) && slot !== null && it.questions.filter((q) => q.kind === 'variant').length < b.config.variantsPerMother && !it.variantsDone;
}

export async function run(store: Store, batchId: string, llm: Llm, opts: RunOptions = {}): Promise<RunReport> {
  const b = store.getBatch(batchId);
  const say = opts.onProgress ?? (() => {});
  if (b.status === 'stopped') throw new Error('这一批已经停止。要继续请新建批次');
  if (!catalogOf(b).length) throw new Error('这一批还没有产品表：先投产品表（产品表模板-v1.0.xlsx），价格是 AI 买家判断报价的标准答案');
  if (store.listReviews(batchId).some((c) => c.kind === 'budget' && !c.answer)) {
    return { status: 'paused', processed: 0, pendingReviews: pendingCount(store, batchId), usage: b.usage };
  }
  b.status = 'running';
  store.saveBatch(b);
  redactPending(store, batchId);
  let processed = 0;
  // 已经开工（归过型）的素材份数：批次设了开工上限时，到数就不再开新的
  // 发言太少直接跳过的不算开工（没花钱，也不该占「先加工 5 份」的名额）
  const begun = (x: Item) => x.triage !== undefined || ['triaged', 'drafted', 'done', 'failed'].includes(x.status);
  let started = b.items.filter((id) => begun(store.getItem(batchId, id))).length;
  try {
    for (const id of b.items) {
      if (opts.limit !== undefined && processed >= opts.limit) break;
      const it = store.getItem(batchId, id);
      const m = store.getMaterial<RedactedMaterial>(batchId, it.materialId);
      let touched = false;
      if (it.status === 'redacted' && m && b.config.processLimit !== undefined && started >= b.config.processLimit) continue;
      if (it.status === 'redacted' && m) {
        started += 1;
        say(`③ 归型 ${it.materialId}`);
        await triage(store, b, llm, it, m);
        store.saveItem(batchId, it);
        touched = true;
      }
      if (it.status === 'triaged' && m) {
        say(`④ 起草 ${it.materialId}（${syllabusType(it.triage!.type_code)!.name}）`);
        await draft(store, b, llm, it, m);
        store.saveItem(batchId, it);
        touched = true;
      }
      // 主管选了「退回修订」或「其他」的题
      for (const q of it.questions.filter((x) => x.status === 'revising')) {
        say(`⑥ 修订 ${q.qid}`);
        const t = syllabusType(q.persona.skeleton.type_code)!;
        q.attempts = 0; // 主管要求的修订重新计次：起草时用掉的次数不该挤占它
        const mother = q.kind === 'variant' ? it.questions.find((x) => x.qid === q.parent)?.persona : undefined;
        await gateAndRevise(store, b, llm, q, q.kind === 'mother' ? materialOf(m) : null, t, q.revisionNote ?? '按质检提醒逐条修好', mother);
        // 标出改了哪里（需求文档 8.1 第 4 条），上一版用完就丢
        const changes = q.before ? personaChanges(q.before, q.persona) : undefined;
        delete q.before;
        if (q.status === 'awaiting_review') q.reviewIds.push(addCard(store, batchId, { ...questionCard(it, q, t), ...(changes ? { changes } : {}) }).id);
        else if (q.kind === 'mother') {
          it.status = 'failed';
          it.reason = `母题修订后仍有 ${hardCount(q.qa)} 个硬问题，见 items/${it.id}.json`;
        }
        store.saveItem(batchId, it);
        touched = true;
      }
      if (needsVariants(b, it)) {
        say(`⑤ 变体 ${it.questions[0]!.qid}`);
        await variants(store, b, llm, it);
        it.variantsDone = true;
        store.saveItem(batchId, it);
        touched = true;
      }
      if (touched) processed += 1;
    }
    b.status = 'open';
  } catch (e) {
    if (!(e instanceof BudgetPaused)) {
      // 模型调用失败（余额不足、网络、限流……）：已完成的都已落盘，批次回到可续跑的状态，原因记进日志
      const msg = (e as Error).message ?? String(e);
      const why = /\b402\b|insufficient balance/i.test(msg) ? '模型账户余额不足，充值后重新 run 即可从断点继续' : `模型调用失败：${msg.slice(0, 200)}`;
      b.status = 'open';
      log(b, why);
      store.saveBatch(b);
      refreshItemStatus(store, batchId);
      throw new Error(why);
    }
    b.status = 'paused';
    addCard(store, batchId, budgetCard(b));
    log(b, `预算到了（${b.usage.costCny} 元），暂停`);
  }
  refreshItemStatus(store, batchId);
  store.saveBatch(b);
  return { status: b.status, processed, pendingReviews: pendingCount(store, batchId), usage: b.usage };
}

/** 素材的题全部定了（采用或弃用，变体也做完了）就算完成 */
function refreshItemStatus(store: Store, batchId: string) {
  const b = store.getBatch(batchId);
  for (const id of b.items) {
    const it = store.getItem(batchId, id);
    if (it.status !== 'drafted') continue;
    const mother = it.questions.find((q) => q.kind === 'mother');
    if (!mother) continue;
    const settled = (q: Question) => ['accepted', 'rejected', 'qa_failed'].includes(q.status);
    if (mother.status === 'rejected' || (settled(mother) && !needsVariants(b, it) && it.questions.every(settled))) {
      it.status = 'done';
      store.saveItem(batchId, it);
    }
  }
}

const pendingCount = (store: Store, batchId: string) => store.listReviews(batchId).filter((c) => !c.answer).length;

/* ═══════════════════ ⑧ 主管确认 ═══════════════════ */

export function answer(store: Store, batchId: string, cardId: string, option: string, text?: string, by?: string): ReviewCard {
  const card = store.getReview(batchId, cardId);
  if (card.answer) throw new Error(`卡 ${cardId} 已经答过了（${card.answer.option}）`);
  if (!card.options.some((o) => o.key === option)) throw new Error(`卡 ${cardId} 没有选项「${option}」，可选：${card.options.map((o) => o.key).join(' / ')}`);
  if (option === 'other' && !text?.trim()) throw new Error('选「其他」要写下你的意见');
  const b = store.getBatch(batchId);

  if (card.kind === 'use_question') {
    const it = store.getItem(batchId, card.itemId!);
    const q = it.questions.find((x) => x.qid === card.qid)!;
    if (option === 'accept') q.status = 'accepted';
    else if (option === 'reject') q.status = 'rejected';
    else {
      q.status = 'revising';
      q.revisionNote = option === 'other' ? text : undefined;
      q.before = structuredClone(q.persona);
    }
    store.saveItem(batchId, it);
  } else if (card.kind === 'redact_suspect') {
    const it = store.getItem(batchId, card.itemId!);
    const words = /：(.+)。怎么处理/.exec(card.question)?.[1]?.replace(/……$/, '').split('、') ?? [];
    if (option === 'mask_all') it.extraTerms.push(...words);
    else if (option === 'pass') it.allowSuspects = true;
    else if (option === 'other') it.extraTerms.push(...text!.split(/[,，、]/).map((s) => s.trim()).filter(Boolean));
    if (option === 'drop') {
      it.status = 'skipped';
      it.reason = '主管确认不用这份素材';
    } else it.status = 'received';
    store.saveItem(batchId, it);
  } else if (card.kind === 'budget') {
    if (option === 'raise') b.config.budgetCny *= 2;
    else if (option === 'other') {
      const n = Number(text!.replace(/[^\d.]/g, ''));
      if (!Number.isFinite(n) || n <= b.usage.costCny) throw new Error(`新预算要是一个大于已花金额 ${b.usage.costCny} 元的数字`);
      b.config.budgetCny = n;
    } else b.status = 'stopped';
    if (option !== 'stop' && option !== 'stop_pack') b.status = 'open';
    log(b, `预算卡：${option}${text ? `（${text}）` : ''}`);
  }
  card.answer = { option, ...(text ? { text } : {}), at: now(), ...(by ? { by } : {}) };
  store.saveReview(batchId, card);
  store.saveBatch(b);
  if (card.kind === 'redact_suspect') redactPending(store, batchId, true);
  refreshItemStatus(store, batchId);
  return card;
}

/** 「本页全部按推荐处理」：只对演习题的卡生效，考试题必须逐道确认 */
export function answerAllRecommended(store: Store, batchId: string, by?: string): ReviewCard[] {
  const done: ReviewCard[] = [];
  for (const c of store.listReviews(batchId)) {
    if (c.answer || !c.batchable) continue;
    const rec = c.options.find((o) => o.recommended)!;
    done.push(answer(store, batchId, c.id, rec.key, undefined, by));
  }
  return done;
}

/**
 * 重做出错的素材：已归型的回到「待起草」（重新起草，要再花一次钱）；没解析成功的回到「待脱敏」。
 * 只动 failed 状态的素材；不写编号就重做这一批全部出错的。
 */
export function retry(store: Store, batchId: string, itemIds?: string[]): Item[] {
  const b = store.getBatch(batchId);
  const out: Item[] = [];
  for (const id of itemIds?.length ? itemIds : b.items) {
    const it = store.getItem(batchId, id);
    if (it.status !== 'failed') {
      if (itemIds?.length) throw new Error(`素材 ${id} 的状态是 ${it.status}，只有出错的素材能重做`);
      continue;
    }
    it.reason = undefined;
    it.attempts = 0;
    const mother = it.questions.find((q) => q.kind === 'mother');
    if (mother && mother.status === 'qa_failed') {
      // 已经有一版母题：先按当前闸门重查（规范化后可能就过了，不花钱），过不了再修订，不从头起草
      it.status = 'drafted';
      mother.status = 'revising';
      mother.revisionNote = '';
    } else {
      it.status = it.triage ? 'triaged' : 'received';
      it.questions = [];
    }
    store.saveItem(batchId, it);
    out.push(it);
  }
  log(b, `重做出错的素材：${out.map((x) => x.id).join('、') || '无'}`);
  store.saveBatch(b);
  return out;
}

/* ═══════════════════ 状态与预估 ═══════════════════ */

export interface BatchStatus {
  batch: Batch;
  items: Record<string, number>;
  questions: Record<string, number>;
  pendingReviews: ReviewCard[];
}

export function status(store: Store, batchId: string): BatchStatus {
  const batch = store.getBatch(batchId);
  const items: Record<string, number> = {};
  const questions: Record<string, number> = {};
  for (const id of batch.items) {
    const it = store.getItem(batchId, id);
    items[it.status] = (items[it.status] ?? 0) + 1;
    for (const q of it.questions) questions[q.status] = (questions[q.status] ?? 0) + 1;
  }
  return { batch, items, questions, pendingReviews: store.listReviews(batchId).filter((c) => !c.answer) };
}

/** 开工前预估：按收件箱里（或已脱敏）素材的字数估这一批大概花多少 */
export function estimate(store: Store, batchId: string): Estimate & { materials: number } {
  const b = store.getBatch(batchId);
  const chars: number[] = [];
  const len = (chat: RawChat) => chat.messages.reduce((a, x) => a + x.text.length + 8, 0);
  for (const id of b.items) {
    const it = store.getItem(batchId, id);
    if (['redacted', 'triaged'].includes(it.status)) {
      const m = store.getMaterial<RedactedMaterial>(batchId, it.materialId);
      if (m) chars.push(len(m.chat));
    } else if (['blocked', 'received'].includes(it.status)) {
      // ★ 等主管确认脱敏的也要算进去 ★ 它们确认完多半照样加工；原来漏算，
      // 2026-11-06 网页真跑时 8 份里 4 份在等确认，预估只报了一半的钱
      const raw = join(store.inboxDir(batchId), it.file);
      try {
        if (existsSync(raw)) chars.push(len(it.preRedacted ? (JSON.parse(readFileSync(raw, 'utf8')) as RedactedMaterial).chat : parseChatFile(raw)));
      } catch {
        /* 读不出来的不估 */
      }
    }
  }
  return { ...estimateBatch(chars, b.config.variantsPerMother), materials: chars.length };
}

/* ═══════════════════ ⑨ 分池 + ⑩ 打包 ═══════════════════ */

export interface PackOptions {
  bankId?: string;
  bankVersion: string;
  /** 在已有题库包的基础上加题（新版本 = 旧题 + 本次采用的题） */
  base?: string;
  outRoot?: string;
  /** 打包时剥掉来源备注（_source），对外分发时用 */
  stripSource?: boolean;
  /**
   * 底子里的题在柜子里被改过状态（停用、降为演习）：打新版本时带过去，不然停用的题又活回来。
   * 键是题目编号。由柜子按数据库里当前版本的实际状态传进来——抽屉不认识数据库。
   */
  baseOverrides?: Record<string, { active?: boolean; pool_type?: 'drill' | 'admission_exam' }>;
}

export interface PackReport {
  dir: string;
  manifest: Manifest;
  added: number;
  renumbered: Record<string, string>;
  forcedDrill: string[];
  /** 这次打进去的每道题在题库包里的编号。装入成功后交给 `markPacked`，下次打包就不会再打一遍 */
  refs: { batchId: string; itemId: string; qid: string; id: string }[];
  /** 回炉替换掉的旧题编号（编号不变，内容换成新的） */
  replaced: string[];
  /** 演习池题数：有就能练，不设下限 */
  drill: number;
  /** 考试三个槽位离开考还差多少（只提示，不拦打包） */
  exam: SlotReadiness[];
}

export function pack(store: Store, batchIds: string[], opts: PackOptions): PackReport {
  if (!/^\d+\.\d+\.\d+$/.test(opts.bankVersion)) throw new Error(`题库版本号要写成 主.次.修 的形式，写的是「${opts.bankVersion}」`);
  const baseBank = opts.base ? readBank(resolve(opts.base)) : null;
  const bankId = opts.bankId ?? baseBank?.manifest.bank_id ?? `bank-${randomBytes(6).toString('hex')}`;
  const taken = new Set((baseBank?.personas ?? []).map((p) => p.id));

  let company: Record<string, string> | undefined = baseBank?.company as Record<string, string> | undefined;
  let products: unknown[] | undefined = baseBank?.products as unknown[] | undefined;
  const fresh: Persona[] = [];
  const freshBg: BgPackage[] = [];
  const forcedDrill: string[] = [];
  const origin = new Map<Persona, { batchId: string; itemId: string; qid: string }>();
  /** 回炉题：顶替底子里同编号的旧题 */
  const replaced = new Set<string>();
  /** 母题早先已经打进题库：变体的 derived_from 要指向它在题库里的编号（打包时可能顺延过） */
  const packedMother = new Map<string, string>();
  for (const batchId of batchIds) {
    const b = store.getBatch(batchId);
    if (b.company) company = b.company;
    if (b.products?.length) products = b.products;
    for (const id of b.items) {
      const it = store.getItem(batchId, id);
      for (const q of it.questions) if (q.packed) packedMother.set(q.persona.id, q.packed.id);
      for (const q of it.questions) {
        if (q.status !== 'accepted' || q.packed) continue;
        const p = structuredClone(q.persona);
        if (q.replaces) {
          p.id = q.replaces;
          replaced.add(q.replaces);
        }
        origin.set(p, { batchId, itemId: it.id, qid: q.qid });
        // ⑨ 分池：风险识别这类暂不进考试的题型，不管它从哪来，一律进演习池
        // 落不进任何考试槽位的（简单档询盘局）考试也永远抽不到，同样放进演习池
        if (p.pool_type === 'admission_exam' && (!syllabusType(p.skeleton.type_code)?.exam_eligible || examSlotOf(p) === null)) {
          p.pool_type = 'drill';
          forcedDrill.push(p.id);
        }
        fresh.push(p);
        if (q.bg) freshBg.push(structuredClone(q.bg) as unknown as BgPackage);
      }
    }
  }
  for (const p of fresh) if (p.derived_from && packedMother.has(p.derived_from)) p.derived_from = packedMother.get(p.derived_from)!;
  // 变体的母题没被采用 → 变体不能单独进题库（validateBank 会因为找不到母题而拒绝）
  const ids = new Set(fresh.map((p) => p.id));
  const orphan = fresh.filter((p) => p.derived_from && !ids.has(p.derived_from) && !taken.has(p.derived_from));
  if (orphan.length) throw new Error(`这些变体的母题没被采用：${orphan.map((p) => p.id).join('、')}。先处理母题的确认卡`);
  if (!fresh.length) throw new Error('这几批里没有还没打包的已采用题');

  // 编号撞了旧题库就顺延，变体的 derived_from 跟着改
  const renumbered: Record<string, string> = {};
  for (const p of fresh) {
    let id = p.id;
    while (taken.has(id) && !replaced.has(id)) {
      const [type, cc, n] = id.split('-');
      id = `${type}-${cc}-${pad(Number(n) + 1)}`;
    }
    if (id !== p.id) renumbered[p.id] = id;
    taken.add(id);
  }
  for (const p of fresh) {
    if (renumbered[p.id]) p.id = renumbered[p.id]!;
    if (p.derived_from && renumbered[p.derived_from]) p.derived_from = renumbered[p.derived_from];
    if (opts.stripSource) delete (p as Partial<Persona>)._source;
  }
  for (const g of freshBg) if (renumbered[g.persona_id]) g.persona_id = renumbered[g.persona_id]!;

  const dir = join(resolve(opts.outRoot ?? join(store.root, '..', 'banks')), bankId, opts.bankVersion);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} 已经有东西了：题库版本号只增不减、不复用，请换一个版本号`);
  // 底子：去掉被回炉题顶替的，再套上柜子里改过的状态（停用、降为演习）
  const baseKept = (baseBank?.personas ?? [])
    .filter((p) => !replaced.has(p.id))
    .map((p) => {
      const o = opts.baseOverrides?.[p.id];
      return o ? { ...p, ...(o.active !== undefined ? { active: o.active } : {}), ...(o.pool_type ? { pool_type: o.pool_type } : {}) } : p;
    });
  const freshBgIds = new Set(freshBg.map((g) => g.persona_id));
  const manifest = writeBank(dir, {
    personas: [...baseKept, ...fresh],
    bgPackages: [...((baseBank?.bgPackages ?? []) as BgPackage[]).filter((g) => !(replaced.has(g.persona_id) && freshBgIds.has(g.persona_id))), ...freshBg],
    company,
    products,
    bankId,
    bankVersion: opts.bankVersion,
    drawerVersion: DRAWER_VERSION,
    generator: 'drawer',
    sourceBatches: [...new Set([...(baseBank?.manifest.source_batches ?? []), ...batchIds])],
  });
  const v = validateBank(dir);
  if (!v.ok) throw new Error(`打出来的题库包校验不通过：\n${v.errors.slice(0, 20).map((e) => `  ${e.where}：${e.message}`).join('\n')}`);
  const all = [...baseKept, ...fresh];
  const drill = all.filter((p) => p.active !== false && p.pool_type === 'drill').length;
  const refs = fresh.map((p) => ({ ...origin.get(p)!, id: p.id }));
  return { dir, manifest, added: fresh.length - replaced.size, renumbered, forcedDrill, refs, replaced: [...replaced], drill, exam: examReadiness(all) };
}

/**
 * 题库包装入成功后调用：把这次打进去的题标成「已打包」，下次打包跳过它们。
 * ★ 不在 pack 里直接标 ★ 打出包不等于装进去了——装入失败时题还该留在待打包里。
 */
export function markPacked(store: Store, report: PackReport): void {
  const tag = `${report.manifest.bank_id}@${report.manifest.bank_version}`;
  const byItem = new Map<string, PackReport['refs']>();
  for (const r of report.refs) byItem.set(`${r.batchId}/${r.itemId}`, [...(byItem.get(`${r.batchId}/${r.itemId}`) ?? []), r]);
  for (const [key, refs] of byItem) {
    const [batchId, itemId] = key.split('/') as [string, string];
    const it = store.getItem(batchId, itemId);
    for (const r of refs) {
      const q = it.questions.find((x) => x.qid === r.qid);
      if (q) {
        q.packed = { tag, id: r.id };
        delete q.replaces;
      }
    }
    store.saveItem(batchId, it);
  }
}

/**
 * 回炉（阶段 6）：把已经打进题库的一道题退回修订。主管在回流页选「回炉」时调用。
 * 找到它在抽屉里的那一版 → 标成「修订中」，带上回流统计写成的修改意见 → 下次加工时模型照着改、重新过闸、出确认卡
 *（卡上标出改了哪里）→ 采用后打包时**顶替**题库里同编号的旧题。
 * 找不到（不是抽屉做的题，比如旧题库手工题）返回 null，柜子那边就只给「降为演习 / 下架 / 保留」。
 */
export function rework(store: Store, bankId: string, questionId: string, note: string): { batchId: string; itemId: string; qid: string } | null {
  for (const batchId of store.listBatches()) {
    for (const id of store.getBatch(batchId).items) {
      const it = store.getItem(batchId, id);
      const q = it.questions.find((x) => x.packed?.id === questionId && x.packed.tag.startsWith(`${bankId}@`));
      if (!q) continue;
      q.before = structuredClone(q.persona);
      q.status = 'revising';
      q.revisionNote = note;
      q.replaces = questionId;
      delete q.packed;
      store.saveItem(batchId, it);
      const b = store.getBatch(batchId);
      log(b, `回炉 ${questionId}：${note.slice(0, 60)}`);
      store.saveBatch(b);
      return { batchId, itemId: it.id, qid: q.qid };
    }
  }
  return null;
}

/** 这道题能不能回炉：是抽屉做的、在工作区里找得到 */
export function canRework(store: Store, bankId: string, questionId: string): boolean {
  return store.listBatches().some((b) =>
    store.getBatch(b).items.some((id) => store.getItem(b, id).questions.some((q) => q.packed?.id === questionId && q.packed.tag.startsWith(`${bankId}@`))),
  );
}

/** 给测试和命令行看：一份素材现在的 JSON（不含正文） */
export function readItem(store: Store, batchId: string, itemId: string): Item {
  return store.getItem(batchId, itemId);
}

