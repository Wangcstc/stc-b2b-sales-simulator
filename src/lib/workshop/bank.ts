/**
 * 题库工坊的「题库」「覆盖」两页：打包上架、装入、切换 / 回滚、上传、导出、停用某道题、覆盖统计。
 *
 * ★ 题库包存档 ★ 每个经工坊装入的题库包都在 `workspace/banks/<题库号>/<版本>/` 留一份（抽屉打包本来就写在这里）。
 * 打下一个版本要在当前版本上加题，就得找得到当前版本的文件；导出也从这里拿。
 * 用命令行装入、本机没留存档的版本，在题库页再上传一次同一个包就补上存档（内容一样，数据库不动）。
 *
 * ★ 样品题库不当底子 ★ 当前是样品题库时，自己公司的第一个题库从零开始、另起题库号——
 * 不然 8 道虚构的露营用品题就混进了你们公司的题库。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import JSZip from 'jszip';
import {
  computeCoverage,
  examReadiness,
  listBankFiles,
  readBank,
  stripNotes,
  validateBank,
  writeBank,
  type Manifest,
  type Persona,
  type SlotReadiness,
} from '../../../bank-kit/index';
import { markPacked, pack, status, type PackReport } from '../../../drawer/index';
import { POOL_REQUIREMENTS, SYLLABUS } from '../../../standards/index';
import { audit } from '../admin-audit';
import { activateBankVersion, listBankVersions, loadBank, type LoadResult } from '../bank-loader';
import type { CurrentUser } from '../current-user';
import { prisma } from '../db';
import { runState } from './runner';
import { workshopStore } from './service';

const SAMPLE_DIR = resolve('samples/bank');

export function archiveRoot(): string {
  return resolve(workshopStore().root, '..', 'banks');
}

function readManifest(dir: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

const sampleManifest = () => readManifest(SAMPLE_DIR);
export const isSampleBank = (bankId: string) => sampleManifest()?.bank_id === bankId;

/** 某个已装入版本的题库包文件在哪：工坊存档 → 样品目录 → BANK_DIR。找不到返回 null */
export function packageDir(bankId: string, bankVersion: string): string | null {
  const cands = [join(archiveRoot(), bankId, bankVersion), SAMPLE_DIR, ...(process.env.BANK_DIR ? [resolve(process.env.BANK_DIR)] : [])];
  for (const d of cands) {
    const m = readManifest(d);
    if (m && m.bank_id === bankId && m.bank_version === bankVersion) return d;
  }
  return null;
}

/** 把一个题库包存进工坊存档（已经在了就不动） */
function archive(dir: string): string {
  const m = readManifest(dir);
  if (!m) throw new Error('不是题库包：缺 manifest.json');
  const dest = join(archiveRoot(), m.bank_id, m.bank_version);
  if (resolve(dir) !== dest && !existsSync(join(dest, 'manifest.json'))) {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(dir, dest, { recursive: true });
  }
  return dest;
}

/* ─────────── 版本列表 ─────────── */

export interface VersionRow {
  id: string;
  bankId: string;
  bankVersion: string;
  isCurrent: boolean;
  loadedAt: Date;
  generator: string | null;
  counts: Manifest['counts'] | null;
  sample: boolean;
  archived: boolean;
}

export async function versionRows(): Promise<VersionRow[]> {
  return (await listBankVersions(prisma)).map((v) => {
    const m = v.manifest as unknown as Manifest | null;
    return {
      id: v.id,
      bankId: v.bankId,
      bankVersion: v.bankVersion,
      isCurrent: v.isCurrent,
      loadedAt: v.loadedAt,
      generator: v.generator,
      counts: m?.counts ?? null,
      sample: isSampleBank(v.bankId),
      archived: packageDir(v.bankId, v.bankVersion) !== null,
    };
  });
}

/* ─────────── 打包上架 ─────────── */

export interface PackPlan {
  /** 有已采用、还没打包的题的批次（正在加工的不算，等它停下） */
  batches: { id: string; questions: number }[];
  busy: string[];
  questions: number;
  current: VersionRow | null;
  /** 在哪个版本上加题；null ＝ 从零开始 */
  base: { dir: string; bankId: string; bankVersion: string } | null;
  /** 当前版本存在、但本机找不到它的题库包文件：打出来的新版本会缺旧题，不许直接切换 */
  baseMissing: boolean;
  bankId: string | null;
  nextVersion: string;
}

function bumpMinor(v: string): string {
  const [a, b] = v.split('.').map(Number);
  return `${a}.${(b ?? 0) + 1}.0`;
}

export async function packPlan(): Promise<PackPlan> {
  const store = workshopStore();
  const batches: PackPlan['batches'] = [];
  const busy: string[] = [];
  for (const id of store.listBatches()) {
    const n = store.getBatch(id).items.reduce((k, iid) => k + store.getItem(id, iid).questions.filter((q) => q.status === 'accepted' && !q.packed).length, 0);
    if (!n) continue;
    if (runState(id)?.running) busy.push(id);
    else batches.push({ id, questions: n });
  }
  const rows = await versionRows();
  const current = rows.find((r) => r.isCurrent) ?? null;
  let base: PackPlan['base'] = null;
  let baseMissing = false;
  let bankId: string | null = null;
  let nextVersion = '1.0.0';
  if (current && !current.sample) {
    const dir = packageDir(current.bankId, current.bankVersion);
    if (dir) base = { dir, bankId: current.bankId, bankVersion: current.bankVersion };
    else baseMissing = true;
    bankId = current.bankId;
    // 同一个题库号下取最大的版本号再升一档（版本号只增不减、不复用）
    const used = rows.filter((r) => r.bankId === current.bankId).map((r) => r.bankVersion);
    const top = used.sort((x, y) => x.localeCompare(y, undefined, { numeric: true })).pop() ?? current.bankVersion;
    nextVersion = bumpMinor(top);
    while (existsSync(join(archiveRoot(), bankId, nextVersion))) nextVersion = bumpMinor(nextVersion);
  }
  return { batches, busy, questions: batches.reduce((n, b) => n + b.questions, 0), current, base, baseMissing, bankId, nextVersion };
}

/**
 * 当前版本里每道题在柜子里的实际状态（停用、降为演习）。打下一个版本时带过去——
 * 不然在题库页停用的、回流页下架或降级的题，打个新版本就又活回来了。
 */
async function currentOverrides(): Promise<Record<string, { active: boolean; pool_type: 'drill' | 'admission_exam' }>> {
  const rows = await prisma.personaVariant.findMany({
    where: { bankVersion: { isCurrent: true } },
    select: { variantId: true, enabledInBank: true, poolType: true },
  });
  return Object.fromEntries(rows.map((r) => [r.variantId, { active: r.enabledInBank, pool_type: r.poolType === 'DRILL' ? 'drill' : 'admission_exam' }]));
}

export type PackOption = 'activate' | 'load' | 'later' | 'other';

export interface PackOutcome {
  report: PackReport;
  load: LoadResult;
  exam: SlotReadiness[];
  drill: number;
}

export async function decidePack(user: CurrentUser, option: PackOption, text?: string): Promise<PackOutcome | null> {
  if (option === 'later') return null;
  const plan = await packPlan();
  if (!plan.batches.length) throw new Error('没有已采用、还没打包的题');
  let version = plan.nextVersion;
  let activate = option === 'activate';
  if (option === 'other') {
    const v = /\d+\.\d+\.\d+/.exec(text ?? '')?.[0];
    if (!v) throw new Error('「其他」请写一个版本号，如 1.2.0（装入但先不切换）');
    version = v;
    activate = false;
  }
  if (activate && plan.baseMissing) throw new Error('本机找不到当前题库包的文件，打出来的新版本会缺掉现有的题。先在下面上传当前题库包补存档，或者选「装入但先不切换」');
  const store = workshopStore();
  const report = pack(store, plan.batches.map((b) => b.id), {
    bankVersion: version,
    ...(plan.base ? { baseOverrides: await currentOverrides() } : {}),
    ...(plan.bankId ? { bankId: plan.bankId } : {}),
    ...(plan.base ? { base: plan.base.dir } : {}),
    outRoot: archiveRoot(),
  });
  const load = await loadBank(prisma, report.dir, { activate });
  markPacked(store, report);
  await audit({
    actorId: user.id,
    action: 'BANK_PACK',
    after: `${report.manifest.bank_id} v${report.manifest.bank_version}：新增 ${report.added} 道，共 ${report.manifest.counts.total} 道${activate ? '，已切换为当前版本' : '，已装入未切换'}`,
    note: text?.trim() || null,
  });
  return { report, load, exam: report.exam, drill: report.drill };
}

/* ─────────── 切换 / 回滚 ─────────── */

export async function decideActivate(user: CurrentUser, versionId: string, option: 'switch' | 'keep' | 'other', text?: string): Promise<boolean> {
  if (option === 'keep') return false;
  if (option === 'other') {
    await audit({ actorId: user.id, action: 'BANK_ACTIVATE', after: '没有切换', note: text?.trim() || null });
    return false;
  }
  const rows = await versionRows();
  const from = rows.find((r) => r.isCurrent);
  const to = rows.find((r) => r.id === versionId);
  if (!to) throw new Error('没有这个题库版本');
  await activateBankVersion(prisma, versionId);
  await audit({
    actorId: user.id,
    action: 'BANK_ACTIVATE',
    before: from ? `${from.bankId} v${from.bankVersion}` : '无',
    after: `${to.bankId} v${to.bankVersion}`,
  });
  return true;
}

/* ─────────── 上传题库包（托管平台、或补存档） ─────────── */

export async function uploadPackage(user: CurrentUser, files: { path: string; data: Buffer }[], activate: boolean): Promise<LoadResult> {
  const tmp = mkdtempSync(join(tmpdir(), 'bank-upload-'));
  try {
    for (const f of files) {
      const rel = f.path.replace(/\\/g, '/').replace(/^\/+/, '');
      if (rel.split('/').some((seg) => seg === '..')) throw new Error(`文件路径不合法：${f.path}`);
      const dest = join(tmp, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.data);
    }
    // 选的是题库包目录，浏览器会带上一层目录名；找到 manifest.json 所在那一层
    const root = findManifestDir(tmp);
    if (!root) throw new Error('上传的文件里没有 manifest.json：请选题库包所在的那个目录（里面有 manifest.json、personas/）');
    const v = validateBank(root);
    if (!v.ok) throw new Error(`题库包校验不通过：${v.errors.slice(0, 5).map((e) => `${e.where}：${e.message}`).join('；')}`);
    const dir = archive(root);
    const r = await loadBank(prisma, dir, { activate });
    await audit({ actorId: user.id, action: 'BANK_LOAD', after: `${r.bankId} v${r.bankVersion}：${r.status === 'already-loaded' ? '已装入过，补了存档' : `装入 ${r.questions} 道${r.activated ? '，已切换为当前版本' : ''}`}` });
    return r;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function findManifestDir(root: string): string | null {
  if (existsSync(join(root, 'manifest.json'))) return root;
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (d.isDirectory()) {
      const hit = findManifestDir(join(root, d.name));
      if (hit) return hit;
    }
  }
  return null;
}

/** 首次引导的「先装样品题库试玩」 */
export async function loadSample(user: CurrentUser): Promise<LoadResult> {
  const r = await loadBank(prisma, SAMPLE_DIR, { activate: true });
  await audit({ actorId: user.id, action: 'BANK_LOAD', after: `样品题库 ${r.bankId} v${r.bankVersion}${r.activated ? '，已切换为当前版本' : ''}` });
  return r;
}

/* ─────────── 导出 ─────────── */

/** 打成 zip。strip：剥掉来源备注（_source 等下划线字段）再导出，给外部用 */
export async function exportZip(user: CurrentUser, versionId: string, strip: boolean): Promise<{ name: string; data: Buffer }> {
  const v = (await versionRows()).find((r) => r.id === versionId);
  if (!v) throw new Error('没有这个题库版本');
  let dir = packageDir(v.bankId, v.bankVersion);
  if (!dir) throw new Error('本机没有这个版本的题库包文件（不是经题库工坊装入的）。在题库页上传一次同一个包就能补上存档');
  let tmp: string | null = null;
  if (strip) {
    // 剥注会改文件内容，校验值要重算：读出来、剥掉、按原身份重写一份
    const b = readBank(dir);
    tmp = mkdtempSync(join(tmpdir(), 'bank-export-'));
    const out = join(tmp, 'bank');
    writeBank(out, {
      personas: b.personas.map((p) => stripNotes(p) as Persona),
      bgPackages: b.bgPackages.map((g) => stripNotes(g)),
      ...(b.company ? { company: b.company as Record<string, string> } : {}),
      ...(b.products ? { products: b.products as unknown[] } : {}),
      bankId: b.manifest.bank_id,
      bankVersion: b.manifest.bank_version,
      drawerVersion: b.manifest.drawer_version,
      ...(b.manifest.generator ? { generator: b.manifest.generator } : {}),
      createdAt: b.manifest.created_at,
    });
    dir = out;
  }
  try {
    const zip = new JSZip();
    const folder = zip.folder(`${v.bankId}-v${v.bankVersion}`)!;
    for (const rel of [...listBankFiles(dir), 'checksums.json']) folder.file(rel, readFileSync(join(dir, rel)));
    const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await audit({ actorId: user.id, action: 'BANK_EXPORT', after: `${v.bankId} v${v.bankVersion}${strip ? '（剥掉来源备注）' : ''}` });
    return { name: `${v.bankId}-v${v.bankVersion}${strip ? '-对外' : ''}.zip`, data };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/* ─────────── 停用 / 恢复某道题 ─────────── */

export interface QuestionRow {
  id: string;
  code: string;
  typeName: string;
  pool: string;
  enabled: boolean;
  buyer: string;
  company: string;
}

export async function currentQuestions(): Promise<QuestionRow[]> {
  const cur = await prisma.bankVersion.findFirst({ where: { isCurrent: true }, select: { id: true } });
  if (!cur) return [];
  const rows = await prisma.personaVariant.findMany({
    where: { bankVersionId: cur.id },
    select: { id: true, variantId: true, poolType: true, enabledInBank: true, openCard: true, persona: { select: { code: true, name: true } } },
    orderBy: { variantId: 'asc' },
  });
  return rows.map((r) => {
    const o = (r.openCard ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      code: r.variantId,
      typeName: `${r.persona.code} ${r.persona.name}`,
      pool: r.poolType === 'DRILL' ? '演习' : '考试',
      enabled: r.enabledInBank,
      buyer: String(o.name ?? ''),
      company: String(o.company ?? ''),
    };
  });
}

/**
 * 停用：这道题不再出现在题池里（只改当前版本）。已经打过的局照常能打开。
 * ★ 停用考试题前先看槽位 ★ 停完槽位不够了，全员当场开不了考——这种要先拦下来说清楚。
 */
export async function toggleQuestion(user: CurrentUser, variantId: string, enable: boolean, force = false): Promise<{ warning?: string }> {
  const v = await prisma.personaVariant.findUnique({
    where: { id: variantId },
    select: { id: true, variantId: true, poolType: true, enabledInBank: true, bankVersion: { select: { isCurrent: true } } },
  });
  if (!v || !v.bankVersion?.isCurrent) throw new Error('只能停用或恢复当前版本里的题');
  if (!enable && v.poolType === 'ADMISSION_EXAM' && !force) {
    const after = (await examCoverage()).slots;
    const before = after.filter((s) => s.ready).length;
    // 粗算：停掉一道后，所在槽位题数 -1
    const tight = after.find((s) => s.ready && s.questions - 1 < s.needQuestions);
    if (tight && before > 0) return { warning: `停用后「${tight.label}」只剩 ${tight.questions - 1} 道，低于开考要求的 ${tight.needQuestions} 道，全员会开不了考` };
  }
  await prisma.personaVariant.update({ where: { id: variantId }, data: { enabledInBank: enable, active: enable } });
  await audit({ actorId: user.id, action: 'BANK_QUESTION_TOGGLE', before: v.enabledInBank ? '在用' : '已停用', after: `${v.variantId}：${enable ? '恢复' : '停用'}` });
  return {};
}

/* ─────────── 覆盖 ─────────── */

export interface CoverageView {
  version: { bankId: string; bankVersion: string } | null;
  total: number;
  drill: number;
  exam: number;
  slots: SlotReadiness[];
  stages: {
    code: string;
    name: string;
    types: { code: string; name: string; drill: number; exam: number; examEligible: boolean; signals: string }[];
  }[];
}

/** 从数据库里当前在用的题算：和柜子派题、开考看到的是同一批题 */
export async function examCoverage(): Promise<CoverageView> {
  const cur = await prisma.bankVersion.findFirst({ where: { isCurrent: true }, select: { bankId: true, bankVersion: true } });
  const rows = await prisma.personaVariant.findMany({
    where: { active: true },
    select: { poolType: true, difficulty: true, persona: { select: { code: true, sessionType: true, difficulty: true } } },
  });
  // 拼成题库工具包认识的最小形状，覆盖与开考口径就和抽屉打包时报的完全一样
  const personas = rows.map(
    (r) =>
      ({
        skeleton: { type_code: r.persona.code, session_type: r.persona.sessionType === 'FOLLOWUP' ? 'followup' : 'inquiry', difficulty: r.persona.difficulty },
        ...(r.difficulty ? { difficulty: r.difficulty } : {}),
        pool_type: r.poolType === 'DRILL' ? 'drill' : 'admission_exam',
      }) as unknown as Persona,
  );
  const cov = computeCoverage(personas);
  const need = {
    questions: Number(process.env.POOL_EXAM_SLOT_MIN_QUESTIONS) >= 1 ? Number(process.env.POOL_EXAM_SLOT_MIN_QUESTIONS) : POOL_REQUIREMENTS.exam_slot_min_questions,
    types: Number(process.env.POOL_EXAM_SLOT_MIN_TYPES) >= 1 ? Number(process.env.POOL_EXAM_SLOT_MIN_TYPES) : POOL_REQUIREMENTS.exam_slot_min_types,
  };
  const stageOrder = [...new Set(SYLLABUS.types.map((t) => t.stage))];
  return {
    version: cur,
    total: rows.length,
    drill: personas.filter((p) => p.pool_type === 'drill').length,
    exam: personas.filter((p) => p.pool_type === 'admission_exam').length,
    slots: examReadiness(personas, need),
    stages: stageOrder.map((st) => {
      const types = SYLLABUS.types.filter((t) => t.stage === st);
      return {
        code: st,
        name: types[0]!.stage_name,
        types: types.map((t) => ({
          code: t.code,
          name: t.name,
          drill: cov.by_type[t.code]?.drill ?? 0,
          exam: cov.by_type[t.code]?.admission_exam ?? 0,
          examEligible: t.exam_eligible,
          signals: t.material_signals,
        })),
      };
    }),
  };
}

/** 加工页「打包上架」卡要用的：这几批里的题有几道等确认（等确认的打不进去） */
export function awaitingIn(batchIds: string[]): number {
  const store = workshopStore();
  return batchIds.reduce((n, id) => n + (status(store, id).questions.awaiting_review ?? 0), 0);
}

