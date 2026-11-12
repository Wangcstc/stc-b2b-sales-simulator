/**
 * 题库工坊（柜子一侧）：投料、加工、确认三页背后的事。
 *
 * ★ 柜子只管「谁能点、点了记一笔、页面怎么摆」★ 加工的每一步都是抽屉的公开接口
 *（`drawer/index`），命令行 `npm run drawer` 调的是同一套，结果完全一致（需求文档 5.4）。
 *
 * ★ 服务器上没有原始聊天 ★ 投料页在主管自己的浏览器里解析、脱敏（`drawer/browser`），
 * 这里收到的已经是脱敏后的素材，当「已脱敏素材」投进抽屉——抽屉照样按当前规则和本批词表补跑一遍。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  Store,
  answer,
  answerAllRecommended,
  createBatch,
  estimate,
  ingest,
  readMaskFile,
  retry,
  status,
  type Batch,
  type Item,
  type Question,
  type RawChat,
  type ReviewCard,
} from '../../../drawer/index';
import { SYLLABUS, syllabusType } from '../../../standards/index';
import { audit } from '../admin-audit';
import type { CurrentUser } from '../current-user';
import { DIFFICULTY_LABEL, POOL_LABEL } from './labels';
import { runState, startRun, type RunState } from './runner';

const g = globalThis as unknown as { __workshopStore?: Store };
/** 抽屉工作区。默认 workspace/drawer/（.gitignore 里），可用 DRAWER_DIR 改 */
export function workshopStore(): Store {
  return (g.__workshopStore ??= new Store());
}
/** 测试用：换一个临时工作区 */
export function setWorkshopStore(s: Store | undefined) {
  g.__workshopStore = s;
}

/* ─────────── 脱敏词表 ─────────── */

/** 投料页要在浏览器里脱敏，得先拿到本机配的脱敏词表（DRAWER_MASK_FILE）。没配就是空的 */
export function maskTerms(): string[] {
  const f = process.env.DRAWER_MASK_FILE;
  if (!f || !existsSync(resolve(f))) return [];
  return readMaskFile(resolve(f));
}

/* ─────────── 投料 ─────────── */

export interface UploadedMaterial {
  /** 浏览器起的名字（c001-化名），不带原文件名——原文件名里常常就是客户真名 */
  label: string;
  chat: RawChat;
}

export interface IngestSummary {
  batchId: string;
  chats: number;
  usable: number;
  blocked: number;
  products: number | null;
  productsInherited: boolean;
  company: boolean;
  estimateCny: number;
  pricesConfigured: boolean;
  materials: number;
  /** 这是工坊里的第一批：推荐先加工 5 份看看效果 */
  firstBatch: boolean;
}

function newBatchId(store: Store): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `w${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  let id = base;
  for (let i = 2; store.hasBatch(id); i += 1) id = `${base}-${i}`;
  return id;
}

/** 最近一批带了产品表的：这次没交产品表就沿用它（产品一般不会每批都变） */
function latestWithProducts(store: Store, except: string): Batch | undefined {
  return store
    .listBatches()
    .filter((id) => id !== except)
    .map((id) => store.getBatch(id))
    .filter((b) => b.products?.length)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export async function ingestUpload(
  user: CurrentUser,
  input: { materials: UploadedMaterial[]; products?: Buffer; company?: Buffer; extraMask?: string[] },
): Promise<IngestSummary> {
  const store = workshopStore();
  if (!input.materials.length) throw new Error('没有收到聊天记录');
  const tmp = mkdtempSync(join(tmpdir(), 'workshop-'));
  try {
    const paths: string[] = [];
    input.materials.forEach((m, i) => {
      const label = /^[a-z0-9-]{3,60}$/.test(m.label) ? m.label : `c${String(i + 1).padStart(3, '0')}`;
      const dir = join(tmp, label);
      mkdirSync(dir, { recursive: true });
      // 来源文件名一律换成标签：原文件名里常有客户名、询价单号（浏览器那边也换过，这里再保一道）
      const chat = { ...m.chat, source: { ...m.chat.source, file: `${label}.html` } };
      writeFileSync(join(dir, 'redacted.json'), JSON.stringify({ material_id: '', digest: {}, audit: [], chat }));
      paths.push(dir);
    });
    if (input.products) {
      writeFileSync(join(tmp, '产品表.xlsx'), input.products);
      paths.push(join(tmp, '产品表.xlsx'));
    }
    if (input.company) {
      writeFileSync(join(tmp, '公司信息.xlsx'), input.company);
      paths.push(join(tmp, '公司信息.xlsx'));
    }
    const batchId = newBatchId(store);
    const terms = [...new Set([...maskTerms(), ...(input.extraMask ?? [])])];
    createBatch(store, batchId, terms.length ? { maskTerms: terms } : {});
    const r = await ingest(store, batchId, paths);

    let inherited = false;
    if (r.products === null) {
      const prev = latestWithProducts(store, batchId);
      if (prev) {
        const b = store.getBatch(batchId);
        b.products = prev.products;
        if (!r.company && prev.company) b.company = prev.company;
        store.saveBatch(b);
        inherited = true;
      }
    }
    const s = status(store, batchId);
    const e = estimate(store, batchId);
    await audit({ actorId: user.id, action: 'WORKSHOP_INGEST', after: `批次 ${batchId}：聊天 ${r.chats} 份${r.products !== null ? `、产品 ${r.products} 个` : inherited ? '、沿用上一批产品表' : ''}` });
    return {
      batchId,
      chats: r.chats,
      usable: (s.items.redacted ?? 0) + (s.items.blocked ?? 0),
      blocked: s.items.blocked ?? 0,
      products: r.products ?? (inherited ? (store.getBatch(batchId).products?.length ?? 0) : null),
      productsInherited: inherited,
      company: r.company || Boolean(store.getBatch(batchId).company),
      estimateCny: e.costCny,
      pricesConfigured: e.pricesConfigured,
      materials: e.materials,
      firstBatch: store.listBatches().length === 1,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ─────────── 开工 ─────────── */

export type StartOption = 'all' | 'five' | 'save' | 'other';

export async function decideStart(user: CurrentUser, batchId: string, option: StartOption, text?: string): Promise<string> {
  const store = workshopStore();
  const b = store.getBatch(batchId);
  if (!b.products?.length) throw new Error('这一批还没有产品表：先投产品表，价格是 AI 买家判断报价的标准答案');
  let say: string;
  if (option === 'save') {
    // 开工上限设成 0：之后答脱敏卡之类的动作不会顺手把加工跑起来、花了钱
    b.config.processLimit = 0;
    say = '先不加工，只保存';
  }
  else if (option === 'all') {
    delete b.config.processLimit;
    say = '全部开始加工';
  } else if (option === 'five') {
    b.config.processLimit = 5;
    say = '先加工 5 份';
  } else {
    // 「其他」：写份数（10）或预算（预算 30）
    const t = (text ?? '').trim();
    const budget = /预算\s*([\d.]+)/.exec(t);
    const n = /^(\d+)\s*份?$/.exec(t);
    if (budget) {
      b.config.budgetCny = Number(budget[1]);
      delete b.config.processLimit;
      say = `全部加工，预算 ${budget[1]} 元`;
    } else if (n) {
      b.config.processLimit = Number(n[1]);
      say = `先加工 ${n[1]} 份`;
    } else throw new Error('「其他」请写份数（如 10）或预算（如 预算 30）');
  }
  store.saveBatch(b);
  await audit({ actorId: user.id, action: 'WORKSHOP_RUN', after: `批次 ${batchId}：${say}`, note: text?.trim() || null });
  if (option !== 'save') startRun(store, batchId);
  return say;
}

/** 已经开工的批次，放开剩下的（加工页「接着做剩下的」） */
export async function releaseRest(user: CurrentUser, batchId: string): Promise<void> {
  const store = workshopStore();
  const b = store.getBatch(batchId);
  const fresh = b.config.processLimit === 0;
  delete b.config.processLimit;
  store.saveBatch(b);
  await audit({ actorId: user.id, action: 'WORKSHOP_RUN', after: `批次 ${batchId}：${fresh ? '开始加工' : '接着加工剩下的'}` });
  startRun(store, batchId);
}

export async function continueRun(user: CurrentUser, batchId: string): Promise<RunState> {
  await audit({ actorId: user.id, action: 'WORKSHOP_RUN', after: `批次 ${batchId}：继续加工` });
  return startRun(workshopStore(), batchId);
}

export type RetryOption = 'all' | 'one' | 'later' | 'other';

export async function decideRetry(user: CurrentUser, batchId: string, option: RetryOption, text?: string): Promise<number> {
  const store = workshopStore();
  if (option === 'later') return 0;
  const failed = store.getBatch(batchId).items.filter((id) => store.getItem(batchId, id).status === 'failed');
  let ids = option === 'one' ? failed.slice(0, 1) : failed;
  if (option === 'other') {
    ids = (text ?? '').split(/[,，、\s]+/).filter((x) => failed.includes(x));
    if (!ids.length) throw new Error(`「其他」请写要重做的素材号，可选：${failed.join('、')}`);
  }
  const done = retry(store, batchId, ids);
  await audit({ actorId: user.id, action: 'WORKSHOP_RETRY', after: `批次 ${batchId}：重做 ${done.map((x) => x.id).join('、')}` });
  if (done.length) startRun(store, batchId);
  return done.length;
}

/* ─────────── 加工进度 ─────────── */

export interface BatchRow {
  id: string;
  createdAt: string;
  status: Batch['status'];
  items: Record<string, number>;
  questions: Record<string, number>;
  pending: number;
  costCny: number;
  processLimit?: number;
  notStarted: number;
  run?: RunState;
  lastLog?: string;
  hasProducts: boolean;
  unpacked: number;
  /** 还有没做完的活（等起草、修订中、开工上限内没开工的、上一轮被打断的）：「继续加工」才有意义 */
  hasWork: boolean;
}

export function batchRows(): BatchRow[] {
  const store = workshopStore();
  return store
    .listBatches()
    .map((id) => {
      const s = status(store, id);
      const unpacked = s.batch.items.reduce((n, iid) => n + store.getItem(id, iid).questions.filter((q) => q.status === 'accepted' && !q.packed).length, 0);
      return {
        id,
        createdAt: s.batch.createdAt,
        status: s.batch.status,
        items: s.items,
        questions: s.questions,
        pending: s.pendingReviews.length,
        costCny: s.batch.usage.costCny,
        ...(s.batch.config.processLimit !== undefined ? { processLimit: s.batch.config.processLimit } : {}),
        notStarted: s.items.redacted ?? 0,
        ...(runState(id) ? { run: runState(id) } : {}),
        ...(s.batch.log.length ? { lastLog: s.batch.log[s.batch.log.length - 1]!.msg } : {}),
        hasProducts: Boolean(s.batch.products?.length),
        unpacked,
        hasWork:
          (s.items.triaged ?? 0) > 0 ||
          (s.items.received ?? 0) > 0 ||
          (s.questions.revising ?? 0) > 0 ||
          // 状态停在「加工中」却没有在跑：上一轮被服务器重启之类的打断了
          (s.batch.status === 'running' && !runState(id)?.running) ||
          Boolean(runState(id)?.error) ||
          ((s.items.redacted ?? 0) > 0 && s.batch.config.processLimit === undefined),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface ItemRow {
  id: string;
  label: string;
  status: Item['status'];
  type?: string;
  reason?: string;
  questions: { qid: string; kind: Question['kind']; status: Question['status']; pool: string; packed?: string }[];
}

export function batchItems(batchId: string): ItemRow[] {
  const store = workshopStore();
  return store.getBatch(batchId).items.map((id) => {
    const it = store.getItem(batchId, id);
    return {
      id: it.id,
      label: it.file.replace(/\.redacted\.json$/, ''),
      status: it.status,
      ...(it.triage ? { type: syllabusType(it.triage.type_code)?.name ?? it.triage.type_code } : {}),
      ...(it.reason ? { reason: it.reason } : {}),
      questions: it.questions.map((q) => ({
        qid: q.qid,
        kind: q.kind,
        status: q.status,
        pool: POOL_LABEL[q.persona.pool_type] ?? q.persona.pool_type,
        ...(q.packed ? { packed: q.packed.tag } : {}),
      })),
    };
  });
}

/* ─────────── 确认队列 ─────────── */

export interface CardView {
  batchId: string;
  card: ReviewCard;
  /** 题目卡上半部分：30 秒看完（需求文档 8.2） */
  summary?: {
    kind: '母题' | '变体';
    parent?: string;
    buyer: string;
    company: string;
    country: string;
    inquiry: string;
    type: string;
    tests: string;
    difficulty: string;
    pool: string;
    hiddenCards: number;
    index: number | null;
    warnings: string[];
    calibration: string[];
  };
  /** 疑似漏网卡：是哪一份素材 */
  material?: string;
}

function summaryOf(q: Question): CardView['summary'] {
  const p = q.persona;
  const o = p.open_card as Record<string, unknown>;
  const t = syllabusType(p.skeleton.type_code);
  return {
    kind: q.kind === 'mother' ? '母题' : '变体',
    ...(q.parent ? { parent: q.parent } : {}),
    buyer: String(o.name ?? ''),
    company: String(o.company ?? ''),
    country: String(o.country ?? ''),
    inquiry: String(o.inquiry_text ?? '').slice(0, 600),
    type: t ? `${t.code} ${t.name}` : p.skeleton.type_code,
    tests: t?.tests ?? '',
    difficulty: DIFFICULTY_LABEL[p.difficulty ?? p.skeleton.difficulty] ?? String(p.skeleton.difficulty),
    pool: POOL_LABEL[p.pool_type] ?? p.pool_type,
    hiddenCards: Object.keys(p.hidden_card).filter((k) => !k.startsWith('_')).length,
    index: q.calibration?.index ?? null,
    warnings: q.qa.filter((x) => x.level === '⚠').map((x) => x.what),
    calibration: (q.calibration?.problems ?? []).map((x) => `${x.level} ${x.what}`),
  };
}

export function pendingCards(batchId?: string): CardView[] {
  const store = workshopStore();
  const out: CardView[] = [];
  for (const id of batchId ? [batchId] : store.listBatches()) {
    for (const c of status(store, id).pendingReviews) {
      const v: CardView = { batchId: id, card: c };
      if (c.itemId) {
        const it = store.getItem(id, c.itemId);
        if (c.kind === 'use_question' && c.qid) {
          const q = it.questions.find((x) => x.qid === c.qid);
          if (q) v.summary = summaryOf(q);
        } else v.material = it.file.replace(/\.redacted\.json$/, '');
      }
      out.push(v);
    }
  }
  return out;
}

export function pendingCount(): number {
  const store = workshopStore();
  return store.listBatches().reduce((n, id) => n + store.listReviews(id).filter((c) => !c.answer).length, 0);
}

export async function answerCard(user: CurrentUser, batchId: string, cardId: string, option: string, text?: string): Promise<ReviewCard> {
  const store = workshopStore();
  const card = answer(store, batchId, cardId, option, text, user.code);
  const label = card.options.find((o) => o.key === option)?.label ?? option;
  await audit({ actorId: user.id, action: 'WORKSHOP_ANSWER', after: `批次 ${batchId}：${card.question} → ${label}`, note: text?.trim() || null });
  // 退回修订、采用母题（要衍生变体）、放开脱敏、追加预算……答完多半有活要干，交给后台接着跑
  if (!(card.kind === 'budget' && (option === 'stop' || option === 'stop_pack'))) startRun(store, batchId);
  return card;
}

export async function answerAll(user: CurrentUser, batchId: string): Promise<number> {
  const store = workshopStore();
  const done = answerAllRecommended(store, batchId, user.code);
  if (done.length) {
    await audit({ actorId: user.id, action: 'WORKSHOP_ANSWER', after: `批次 ${batchId}：演习题 ${done.length} 张卡全部按推荐处理` });
    startRun(store, batchId);
  }
  return done.length;
}

/** 覆盖页「建议补什么样的聊天」：考纲里每一型写好的素材特征 */
export function materialHint(code: string): string {
  return SYLLABUS.types.find((t) => t.code === code)?.material_signals ?? '';
}

/** 投料页要提前知道：这次不交产品表，有没有上一批可以沿用 */
export function latestProducts(): { batchId: string; count: number; company: boolean } | null {
  const b = latestWithProducts(workshopStore(), '');
  return b ? { batchId: b.id, count: b.products!.length, company: Boolean(b.company) } : null;
}
