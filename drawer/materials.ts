/**
 * 原材料表：产品表、公司信息表（`standards/templates/` 的 Excel 模板）→ 结构化数据。
 *
 * 列定义只认标准层那一份 `RAW_MATERIAL_TEMPLATES`，与生成模板的脚本同一个真源，改列只改那里。
 * 模板布局：列式表第 4 行表头、第 5 行示例、第 6 行起是数据，数据从 B 列开始；
 * 行式表（公司信息）从第 5 行起，C 列是填写值。
 */
import ExcelJS from 'exceljs';
import { RAW_MATERIAL_TEMPLATES, type TemplateField, type TemplateFile } from '../standards/index';
import type { Product } from '../bank-kit/index';

export interface CatalogEntry {
  sku: string;
  name: string;
  model?: string;
  category: string;
  specs?: string[];
  page_price?: string;
  moq: string;
  sample_days?: number | null;
  bulk_days: number | null;
  sample_policy?: string;
  customization?: string;
  price_tiers: { min_qty: number; unit_price: number; currency: string; incoterm: string; port?: string }[];
  packing?: Record<string, string | number | null>;
  certifications?: { name: string; market?: string; number?: string; valid_until?: string }[];
}

export class MaterialError extends Error {}

const spec = (key: 'products' | 'company'): TemplateFile => {
  const f = RAW_MATERIAL_TEMPLATES.files.find((x) => x.key === key);
  if (!f) throw new MaterialError(`标准层里没有「${key}」模板的定义`);
  return f;
};

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if ('result' in v) return (v as ExcelJS.CellFormulaValue).result ?? null;
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('');
    if ('text' in v) return (v as { text: string }).text;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return v;
}

function coerce(field: TemplateField, raw: unknown, where: string): unknown {
  if (raw === null || raw === '') return null;
  if (field.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, '').trim());
    if (!Number.isFinite(n)) throw new MaterialError(`${where}「${field.label}」应为数字，填的是「${String(raw)}」`);
    return n;
  }
  const s = String(raw).trim();
  if (field.type === 'list') return s.split(/[;；\n]/).map((x) => x.trim()).filter(Boolean);
  if (field.type === 'choice' && field.choices && !field.choices.includes(s)) {
    throw new MaterialError(`${where}「${field.label}」只能填 ${field.choices.join(' / ')}，填的是「${s}」`);
  }
  return s;
}

async function load(path: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb;
}

function readColumns(wb: ExcelJS.Workbook, sheetName: string, columns: TemplateField[]): Record<string, unknown>[] {
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new MaterialError(`缺少工作表「${sheetName}」：请用 standards/templates 里的模板填写`);
  const out: Record<string, unknown>[] = [];
  for (let r = 6; r <= ws.rowCount; r += 1) {
    const row: Record<string, unknown> = {};
    let any = false;
    columns.forEach((col, c) => {
      const v = coerce(col, cellValue(ws.getCell(r, 2 + c).value), `「${sheetName}」第 ${r} 行`);
      if (v !== null) any = true;
      row[col.key] = v;
    });
    if (!any) continue;
    for (const col of columns) {
      if (col.required && row[col.key] === null) throw new MaterialError(`「${sheetName}」第 ${r} 行「${col.label}」是必填项`);
    }
    out.push(row);
  }
  return out;
}

const omitNull = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) as T;

/** 读产品表（四张工作表按产品编号合并） */
export async function readProductSheet(path: string): Promise<CatalogEntry[]> {
  const f = spec('products');
  const wb = await load(path);
  const sheet = (name: string) => f.sheets.find((s) => s.name === name)!;
  const [products, tiers, packing, certs] = ['产品', '价格阶梯', '包装物流', '认证'].map((n) =>
    readColumns(wb, n, sheet(n).columns!),
  );
  const skus = new Set(products!.map((p) => p.sku as string));
  for (const [name, rows] of [['价格阶梯', tiers], ['包装物流', packing], ['认证', certs]] as const) {
    for (const r of rows!) if (!skus.has(r.sku as string)) throw new MaterialError(`「${name}」里的产品编号 ${String(r.sku)} 在「产品」表里没有`);
  }
  return products!.map((p) => {
    const sku = p.sku as string;
    const { sku: _a, ...pack } = packing!.find((x) => x.sku === sku) ?? { sku };
    const entry = omitNull({
      ...p,
      price_tiers: tiers!
        .filter((t) => t.sku === sku)
        .map(({ sku: _s, ...t }) => omitNull(t))
        .sort((a, b) => (a.min_qty as number) - (b.min_qty as number)),
      packing: Object.keys(pack).length ? pack : null,
      certifications: certs!.filter((c) => c.sku === sku).map(({ sku: _s, ...c }) => omitNull(c)),
    }) as unknown as CatalogEntry;
    if (entry.packing) entry.packing = { ...pack } as Record<string, string | number | null>;
    if (!entry.price_tiers.length) throw new MaterialError(`产品 ${sku} 没有填价格阶梯：AI 买家判断报价要用它`);
    return entry;
  });
}

/** 读公司信息表（全部选填，空格不输出） */
export async function readCompanySheet(path: string): Promise<Record<string, string>> {
  const f = spec('company');
  const wb = await load(path);
  const sheet = f.sheets[0]!;
  const ws = wb.getWorksheet(sheet.name);
  if (!ws) throw new MaterialError(`缺少工作表「${sheet.name}」：请用 standards/templates 里的模板填写`);
  const out: Record<string, string> = {};
  sheet.rows!.forEach((row, i) => {
    const v = coerce(row, cellValue(ws.getCell(5 + i, 3).value), `「${sheet.name}」`);
    if (v !== null) out[row.key] = String(v);
  });
  return out;
}

const numIn = (s: unknown): number | string => {
  const m = /[\d.]+/.exec(String(s ?? ''));
  return m ? Number(m[0]) : String(s ?? '');
};

/**
 * 产品目录的一行 → 题目里的产品卡（题库格式 v1 的产品字段）。
 * 档位上限按下一档的起订量推出来；规格「键: 值」拆成属性，「A / B / C」拆成数组。
 */
export function catalogToProduct(e: CatalogEntry): Product {
  const attributes: Record<string, unknown> = {};
  for (const s of e.specs ?? []) {
    const i = s.indexOf(':');
    if (i === -1) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim();
    attributes[k] = v.includes(' / ') ? v.split(' / ').map((x) => x.trim()) : v;
  }
  const tiers = [...e.price_tiers].sort((a, b) => a.min_qty - b.min_qty);
  const moqM = /^\s*([\d,]+)\s*(.*)$/.exec(e.moq);
  const product: Product = {
    ...(e.model ? { model: e.model } : {}),
    name: e.name,
    ...(Object.keys(attributes).length ? { attributes } : {}),
    ...(e.page_price ? { page_price: e.page_price } : {}),
    price_tiers: tiers.map((t, i) => ({
      min_qty: t.min_qty,
      max_qty: tiers[i + 1] ? tiers[i + 1]!.min_qty - 1 : null,
      unit_price: t.unit_price,
      currency: t.currency,
      incoterm: t.incoterm,
      port: t.port ?? null,
      variant: null,
    })),
    moq: moqM ? { qty: Number(moqM[1]!.replace(/,/g, '')), unit: moqM[2]!.trim() || 'pcs' } : { qty: e.moq },
    lead_time: {
      ...(e.sample_days != null ? { sample_days: e.sample_days } : {}),
      ...(e.bulk_days != null ? { bulk_days: e.bulk_days } : {}),
    },
  };
  if (e.packing) {
    const p = e.packing;
    product.packing = {
      ...(p.qty_per_carton != null ? { qty_per_carton: numIn(p.qty_per_carton) } : {}),
      ...(p.carton_cm != null ? { carton_cm: String(p.carton_cm) } : {}),
      ...(p.gross_kg != null ? { gross_kg: p.gross_kg } : {}),
      ...(p.net_kg != null ? { net_kg: p.net_kg } : {}),
    };
  }
  if (e.certifications?.length) product.certifications = e.certifications.map((c) => ({ name: c.name, ...(c.market ? { market: c.market } : {}) }));
  const extra: Record<string, unknown> = {};
  if (e.sample_policy) extra.sample_policy = e.sample_policy;
  if (e.customization) extra.customization = e.customization;
  if (e.packing?.unit_pack) extra.unit_pack = e.packing.unit_pack;
  if (Object.keys(extra).length) product.extra = extra;
  return product;
}
