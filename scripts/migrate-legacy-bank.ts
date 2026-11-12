/**
 * 把旧格式题目（`personas/` + `bg-packages/`）转成一个题库包（题库格式 v1）。
 *
 *   npx tsx scripts/migrate-legacy-bank.ts <旧题目所在目录> <输出目录> [--bank-id=bank-xxxxxxxx] [--bank-version=1.0.0]
 *
 * 旧题目目录里应有 `personas/*.json`，可选 `bg-packages/*.json`。输出目录必须不存在或为空。
 * 跑完自动做三件事：产品字段无损检查、题库包校验、质量提醒汇总。任何一项硬问题都 exit 1。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lintPersona, migrateLegacy, normalizeProduct, validateBank, writeBank } from '../bank-kit/index';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const [srcDir, outDir] = positional.map((p) => resolve(p));
if (!srcDir || !outDir) {
  console.log('用法：npx tsx scripts/migrate-legacy-bank.ts <旧题目所在目录> <输出目录>');
  process.exit(1);
}
const readDir = (sub: string) =>
  existsSync(join(srcDir, sub))
    ? readdirSync(join(srcDir, sub))
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(srcDir, sub, f), 'utf8')))
    : [];

const legacyPersonas = readDir('personas');
// 文件名 → 内部编号（旧题之间有时用文件名互相指认）
const aliases: Record<string, string> = Object.fromEntries(
  readdirSync(join(srcDir, 'personas'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(srcDir, 'personas', f), 'utf8')).persona_variant_id]),
);
const legacyBgs = readDir('bg-packages');
console.log(`读入旧题 ${legacyPersonas.length} 道、背调包 ${legacyBgs.length} 份`);

// ── 产品字段无损检查：旧产品里的每一个叶子值，都必须在规范化后的产品里找得到 ──
const leaves = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => leaves(x, out));
  else if (v !== null && v !== undefined) out.push(JSON.stringify(v));
  return out;
};
let lost = 0;
for (const p of legacyPersonas) {
  const before = leaves(p.product);
  const after = leaves(normalizeProduct(p.product).product);
  const pool = new Map<string, number>();
  for (const x of after) pool.set(x, (pool.get(x) ?? 0) + 1);
  for (const x of before) {
    const n = pool.get(x) ?? 0;
    if (n === 0) {
      console.log(`✗ ${p.persona_variant_id} 产品里的值 ${x} 在规范化后丢了`);
      lost += 1;
    } else pool.set(x, n - 1);
  }
}
console.log(lost ? `✗ 产品字段有 ${lost} 个值丢失` : '✓ 产品字段无损：每个原值都在规范化后的产品里');

const { personas, bgPackages, report } = migrateLegacy(legacyPersonas, legacyBgs, aliases);
const pkgVersion = String(JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version);
const manifest = writeBank(outDir, {
  personas,
  bgPackages,
  bankId: flag('bank-id') ?? `bank-${randomBytes(6).toString('hex')}`,
  bankVersion: flag('bank-version') ?? '1.0.0',
  drawerVersion: pkgVersion,
  generator: 'legacy-migration',
});
console.log(`✓ 已写出题库包 ${manifest.bank_id} v${manifest.bank_version} → ${outDir}`);
console.log(`  题目 ${manifest.counts.total} 道（演习 ${manifest.counts.drill}、考试 ${manifest.counts.admission_exam}），背调包 ${manifest.counts.bg_packages} 份`);
console.log(`  考试槽位：${Object.entries(manifest.counts.by_slot).map(([k, v]) => `${k} ${v}`).join('，')}`);

const extraCount = Object.keys(report.productExtraKeys).length;
if (extraCount) console.log(`· ${extraCount} 道题的产品有题目专用字段，已放进 product.extra（柜子代码不读，只进买家扮演提示词）`);
const unresolved = Object.entries(report.unresolvedDerivedFrom);
if (unresolved.length) {
  console.log(`· ${unresolved.length} 道题的母题不在这批题里，旧编号留在 _legacy_derived_from：`);
  for (const [id, from] of unresolved) console.log(`    ${id} ← ${from}`);
}

const result = validateBank(outDir);
if (!result.ok) {
  for (const e of result.errors.slice(0, 40)) console.log(`✗ ${e.where}：${e.message}`);
  console.log(`✗ 题库包校验不通过：${result.errors.length} 处`);
  process.exit(1);
}
console.log('✓ 题库包校验通过（结构、考纲、引用、校验和、计数）');

const lint = personas.map((p) => [p.id, lintPersona(p)] as const).filter(([, w]) => w.length);
console.log(`· 质量提醒：${lint.length} 道题未达新题出题标准（不影响装入；抽屉出新题时这些是硬门槛）`);
for (const [id, w] of lint.slice(0, 10)) console.log(`    ${id}：${w[0]}${w.length > 1 ? ` 等 ${w.length} 条` : ''}`);
process.exit(lost ? 1 : 0);
