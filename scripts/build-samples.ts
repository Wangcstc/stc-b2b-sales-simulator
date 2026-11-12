/**
 * 构建样品（`npm run samples:build`）与校验（`npm run check:samples`）。
 *
 *   samples/src/              样品题的真源：题目、背调包、公司信息、产品目录、题库包身份信息
 *   samples/bank/             由 src 构建出的样品题库包（入仓，新用户装好就能用）
 *   samples/raw-materials/    样品原材料：8 份虚构聊天导出件 + 按模板填好的产品表、公司信息表
 *   samples/redacted/         原材料经 npm run import:chat 脱敏后的素材，忠实度质检拿它对照
 *
 * ★ 构建是确定的 ★ 题库包的编号、版本、打包时间都写死在 samples/src/bank.json，
 * 同样的 src 永远构建出逐字节相同的题库包。`--check` 在临时目录重新构建一遍并逐文件比对，
 * 不一致就 exit 1——防止有人改了 samples/bank 却没改 src，或改了 src 忘了重新构建。
 */
import ExcelJS from 'exceljs';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listBankFiles, validateBank, writeBank, type BgPackage, type Persona } from '../bank-kit/index';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'samples/src');
const BANK = join(ROOT, 'samples/bank');
const check = process.argv.includes('--check');

const readJson = <T>(p: string) => JSON.parse(readFileSync(p, 'utf8')) as T;
const listJson = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(dir, f));

function build(outDir: string) {
  const meta = readJson<{ bank_id: string; bank_version: string; drawer_version: string; generator: string; created_at: string }>(join(SRC, 'bank.json'));
  writeBank(outDir, {
    personas: listJson(join(SRC, 'personas')).map((p) => readJson<Persona>(p)),
    bgPackages: listJson(join(SRC, 'bg-packages')).map((p) => readJson<BgPackage>(p)),
    company: readJson(join(SRC, 'company.json')),
    products: readJson(join(SRC, 'products.json')),
    bankId: meta.bank_id,
    bankVersion: meta.bank_version,
    drawerVersion: meta.drawer_version,
    generator: meta.generator,
    createdAt: meta.created_at,
    sourceBatches: ['sample'],
  });
  const r = validateBank(outDir);
  if (!r.ok) {
    for (const e of r.errors) console.log(`✗ ${e.where}：${e.message}`);
    throw new Error('样品题库包校验不通过');
  }
}

/** 按原材料模板填出样品产品表、公司信息表 */
async function fillTemplates() {
  type Col = { key: string };
  type Sheet = { name: string; columns?: Col[]; rows?: Col[]; layout?: string };
  const spec = readJson<{ files: { key: string; file_name: string; sheets: Sheet[] }[] }>(join(ROOT, 'standards/templates/raw-material-templates.json'));
  const products = readJson<Record<string, unknown>[]>(join(SRC, 'products.json'));
  const company = readJson<Record<string, string>>(join(SRC, 'company.json'));

  const rowsFor: Record<string, Record<string, unknown>[]> = {
    产品: products.map((p) => ({ ...p, specs: (p.specs as string[]).join('; ') })),
    价格阶梯: products.flatMap((p) => (p.price_tiers as Record<string, unknown>[]).map((t) => ({ sku: p.sku, ...t }))),
    包装物流: products.map((p) => ({ sku: p.sku, ...(p.packing as Record<string, unknown>) })),
    认证: products.flatMap((p) => (p.certifications as Record<string, unknown>[]).map((c) => ({ sku: p.sku, ...c }))),
  };

  for (const file of spec.files) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(join(ROOT, 'standards/templates', file.file_name));
    for (const sheet of file.sheets) {
      const ws = wb.getWorksheet(sheet.name)!;
      if (sheet.layout === 'rows') {
        sheet.rows!.forEach((row, i) => {
          ws.getCell(5 + i, 3).value = company[row.key] ?? null;
        });
      } else {
        (rowsFor[sheet.name] ?? []).forEach((data, r) => {
          sheet.columns!.forEach((col, c) => {
            const v = data[col.key];
            ws.getCell(6 + r, 2 + c).value = v === undefined || v === null ? null : (v as ExcelJS.CellValue);
          });
        });
      }
    }
    const out = file.file_name.replace('模板-v1.0', '-样品');
    await wb.xlsx.writeFile(join(ROOT, 'samples/raw-materials', out));
    console.log(`✓ samples/raw-materials/${out}`);
  }
}

async function main() {
  if (check) {
    const tmp = mkdtempSync(join(tmpdir(), 'sample-bank-'));
    rmSync(tmp, { recursive: true, force: true });
    build(tmp);
    const a = [...listBankFiles(tmp), 'checksums.json'].sort();
    const b = [...listBankFiles(BANK), 'checksums.json'].sort();
    const diff = [...new Set([...a, ...b])].filter(
      (f) => !a.includes(f) || !b.includes(f) || readFileSync(join(tmp, f), 'utf8') !== readFileSync(join(BANK, f), 'utf8'),
    );
    rmSync(tmp, { recursive: true, force: true });
    if (diff.length) {
      for (const f of diff) console.log(`✗ samples/bank/${f} 与 samples/src 构建结果不一致`);
      console.log('✗ 样品题库包与源文件不一致。改样品只改 samples/src，然后运行 npm run samples:build');
      process.exit(1);
    }
    console.log('✓ 样品题库包与源文件一致');
    return;
  }
  // 题库包一经写出不再修改：构建产物整目录重建（它不是真源，真源是 samples/src）
  rmSync(BANK, { recursive: true, force: true });
  build(BANK);
  console.log('✓ samples/bank 已构建并通过校验');
  await fillTemplates();
}
main();
