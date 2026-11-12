/**
 * 题库包校验。装入前必须全部通过；任何一项不过都不许装入，也不影响柜子当前在用的题库。
 *
 *   1. manifest 存在且符合结构
 *   2. 格式版本兼容：同主版本可装；更新的主版本拒绝（请升级柜子）
 *   3. 校验和：每个文件与 checksums.json 一致，不多不少
 *   4. 每道题、每份背调包通过 JSON Schema；文件名与编号一致；编号不重复
 *   5. 考纲：题型编码存在、题型名与考纲一致；暂不进考试的题型不许放进考试池
 *   6. 引用完整：母题、背调包对应的题、暗牌前置牌、验证用例指向的暗牌都存在
 *   7. manifest 里的计数和 coverage.json 与实际内容一致
 *
 * 质量门槛（暗牌张数等）不在这里卡，见 `lintBank`：那是出题标准，不是格式契约。
 */
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import bgSchema from '../standards/schema/bg-package.schema.json';
import companySchema from '../standards/schema/company.schema.json';
import coverageSchema from '../standards/schema/coverage.schema.json';
import manifestSchema from '../standards/schema/manifest.schema.json';
import personaSchema from '../standards/schema/persona.schema.json';
import productSchema from '../standards/schema/product.schema.json';
import productsSchema from '../standards/schema/products.schema.json';
import { QUALITY_RULES, syllabusType } from '../standards/index';
import { computeCounts, computeCoverage } from './coverage';
import { contentHash, listBankFiles } from './io';
import { BANK_FORMAT_VERSION, type BgPackage, type Coverage, type Manifest, type Persona } from './types';

export interface Finding {
  where: string;
  message: string;
}
export interface ValidationResult {
  ok: boolean;
  errors: Finding[];
}

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(productSchema);
const compiled = {
  manifest: ajv.compile(manifestSchema),
  persona: ajv.compile(personaSchema),
  bg: ajv.compile(bgSchema),
  coverage: ajv.compile(coverageSchema),
  company: ajv.compile(companySchema),
  products: ajv.compile(productsSchema),
};

function schemaErrors(fn: ValidateFunction, data: unknown, where: string): Finding[] {
  if (fn(data)) return [];
  return (fn.errors ?? []).slice(0, 20).map((e: ErrorObject) => ({
    where,
    message: `${e.instancePath || '(根)'} ${e.message ?? ''}${e.params && 'additionalProperty' in e.params ? `：${String(e.params.additionalProperty)}` : ''}`,
  }));
}

/** 单独校验一份背调包的结构 */
export function validateBgPackage(b: unknown, where = 'bg-package'): Finding[] {
  return schemaErrors(compiled.bg, b, where);
}

/** 单独校验一道题的结构（抽屉起草后、写进题库包之前用） */
export function validatePersona(p: unknown, where = 'persona'): Finding[] {
  return schemaErrors(compiled.persona, p, where);
}

const read = (dir: string, rel: string): unknown => JSON.parse(readFileSync(join(dir, rel), 'utf8'));

export function validateBank(dir: string): ValidationResult {
  const errors: Finding[] = [];
  const err = (where: string, message: string) => errors.push({ where, message });

  // 1. manifest
  if (!existsSync(join(dir, 'manifest.json'))) {
    return { ok: false, errors: [{ where: 'manifest.json', message: '缺少 manifest.json，这不是一个题库包' }] };
  }
  const manifest = read(dir, 'manifest.json') as Manifest;

  // 2. 格式版本：先于结构校验，版本不认识时结构校验的报错没有意义
  if (typeof manifest.format_version === 'number' && manifest.format_version > BANK_FORMAT_VERSION) {
    err('manifest.json', `题库格式 v${manifest.format_version} 比柜子支持的 v${BANK_FORMAT_VERSION} 新，请先升级柜子`);
    return { ok: false, errors };
  }
  errors.push(...schemaErrors(compiled.manifest, manifest, 'manifest.json'));

  // 3. 校验和
  if (!existsSync(join(dir, 'checksums.json'))) err('checksums.json', '缺少 checksums.json');
  else {
    const sums = read(dir, 'checksums.json') as Record<string, string>;
    const actual = listBankFiles(dir);
    for (const f of actual) {
      if (!sums[f]) err(f, '这个文件不在 checksums.json 里（打包后被加进来的？）');
      else if (sums[f] !== contentHash(readFileSync(join(dir, f)))) err(f, '校验和对不上：打包后被改过');
    }
    for (const f of Object.keys(sums)) if (!actual.includes(f)) err(f, 'checksums.json 里有，但文件不见了');
  }

  // 4. 题目与背调包
  const personas: Persona[] = [];
  const ids = new Set<string>();
  for (const f of listBankFiles(dir).filter((x) => x.startsWith('personas/'))) {
    const p = read(dir, f) as Persona;
    errors.push(...schemaErrors(compiled.persona, p, f));
    if (p.id && f !== `personas/${p.id}.json`) err(f, `文件名应为 personas/${p.id}.json`);
    if (ids.has(p.id)) err(f, `题目编号 ${p.id} 重复`);
    ids.add(p.id);
    personas.push(p);
  }
  if (personas.length === 0) err('personas/', '题库里一道题都没有');

  const bgs: BgPackage[] = [];
  for (const f of listBankFiles(dir).filter((x) => x.startsWith('bg-packages/'))) {
    const b = read(dir, f) as BgPackage;
    errors.push(...schemaErrors(compiled.bg, b, f));
    if (b.persona_id && f !== `bg-packages/${b.persona_id}.json`) err(f, `文件名应为 bg-packages/${b.persona_id}.json`);
    bgs.push(b);
  }
  if (existsSync(join(dir, 'company.json'))) errors.push(...schemaErrors(compiled.company, read(dir, 'company.json'), 'company.json'));
  if (existsSync(join(dir, 'products.json'))) errors.push(...schemaErrors(compiled.products, read(dir, 'products.json'), 'products.json'));

  // 5. 考纲  6. 引用
  for (const p of personas) {
    const where = `personas/${p.id}.json`;
    const t = p.skeleton ? syllabusType(p.skeleton.type_code) : undefined;
    if (p.skeleton && !t) err(where, `题型编码 ${p.skeleton.type_code} 不在考纲 v${manifest.syllabus_version} 里`);
    if (t && p.skeleton.name !== t.name) err(where, `题型名应为「${t.name}」，写的是「${p.skeleton.name}」`);
    if (t && !t.exam_eligible && p.pool_type === 'admission_exam') err(where, `${t.code} ${t.name} 暂不进考试，不能放进考试池`);
    if (p.derived_from && !ids.has(p.derived_from)) err(where, `母题 ${p.derived_from} 不在题库里`);
    const cards = new Set(Object.keys(p.hidden_card ?? {}).filter((k) => !k.startsWith('_')));
    for (const [k, c] of Object.entries(p.hidden_card ?? {})) {
      if (k.startsWith('_')) continue;
      for (const r of (c as { requires?: string[] }).requires ?? []) {
        if (!cards.has(r)) err(where, `暗牌 ${k} 的前置牌 ${r} 不存在`);
      }
    }
    for (const v of p.verify_cases ?? []) if (!cards.has(v.card)) err(where, `验证用例指向的暗牌 ${v.card} 不存在`);
    for (const q of p._source?.quotes ?? []) if (!cards.has(q.card)) err(where, `来源备注指向的暗牌 ${q.card} 不存在`);
  }
  for (const b of bgs) if (!ids.has(b.persona_id)) err(`bg-packages/${b.persona_id}.json`, `对应的题 ${b.persona_id} 不在题库里`);

  // 7. 计数与覆盖
  const counts = computeCounts(personas, bgs.length);
  if (JSON.stringify(manifest.counts) !== JSON.stringify(counts)) err('manifest.json', 'counts 与题库实际内容不一致');
  if (existsSync(join(dir, 'coverage.json'))) {
    const cov = read(dir, 'coverage.json') as Coverage;
    errors.push(...schemaErrors(compiled.coverage, cov, 'coverage.json'));
    if (JSON.stringify(cov) !== JSON.stringify(computeCoverage(personas))) err('coverage.json', '与题库实际内容不一致');
  } else err('coverage.json', '缺少 coverage.json');

  return { ok: errors.length === 0, errors };
}

/** 出题质量提醒（不阻止装入）。抽屉的质检工序会把这些当成硬门槛 */
export function lintPersona(p: Persona): string[] {
  const q = QUALITY_RULES;
  const out: string[] = [];
  const cards = Object.entries(p.hidden_card ?? {}).filter(([k]) => !k.startsWith('_')) as [string, Record<string, string[]>][];
  if (cards.length < q.hidden_cards.min || cards.length > q.hidden_cards.max) {
    out.push(`暗牌 ${cards.length} 张，标准是 ${q.hidden_cards.min}–${q.hidden_cards.max} 张`);
  }
  for (const [k, c] of cards) {
    const n = (c.unlock_patterns?.length ?? 0) + Math.min(c.unlock_patterns_topic?.length ?? 0, c.unlock_patterns_framing?.length ?? 0);
    if (n < q.unlock_patterns_per_card.min) out.push(`暗牌 ${k} 的解锁条件只有 ${n} 条，标准至少 ${q.unlock_patterns_per_card.min} 条`);
    const v = p.verify_cases?.find((x) => x.card === k);
    if (!v) out.push(`暗牌 ${k} 没有验证用例`);
    else {
      if (v.should.length < q.verify_should_per_card.min) out.push(`暗牌 ${k} 的「应解锁」用例 ${v.should.length} 条，标准至少 ${q.verify_should_per_card.min} 条`);
      if (v.shouldNot.length < q.verify_should_not_per_card.min) out.push(`暗牌 ${k} 的「不应解锁」用例 ${v.shouldNot.length} 条，标准至少 ${q.verify_should_not_per_card.min} 条`);
    }
  }
  if ((p.distractors?.length ?? 0) > q.distractors.max) out.push(`干扰项 ${p.distractors?.length} 个，标准最多 ${q.distractors.max} 个`);
  return out;
}
