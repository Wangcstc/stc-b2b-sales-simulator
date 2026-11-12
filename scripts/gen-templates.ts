/**
 * 按 `standards/templates/raw-material-templates.json` 生成两张原材料 Excel 模板。
 *
 *   npm run gen:templates
 *
 * 视觉按《DESIGN-data》表格交付物规范：白底、藏蓝表头、手填区淡黄底、示例行中性灰底；
 * 中文「等线」、数字「Consolas」；冻结表头；有固定选项的列用下拉框。
 * 品牌橙只出现在标题行左侧那一小条色块，署名只在「填写说明」页尾。
 */
import ExcelJS from 'exceljs';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'standards/templates');
const spec = JSON.parse(readFileSync(join(OUT_DIR, 'raw-material-templates.json'), 'utf8')) as TemplateSpec;

interface Column {
  key: string;
  label: string;
  required?: boolean;
  type: 'text' | 'number' | 'list' | 'choice';
  choices?: string[];
  width?: number;
  example?: string | number;
  hint?: string;
}
interface Sheet {
  name: string;
  purpose: string;
  layout?: 'rows';
  columns?: Column[];
  rows?: Column[];
}
interface TemplateSpec {
  template_version: string;
  files: { key: string; file_name: string; title: string; sheets: Sheet[] }[];
}

/* ── 令牌（DESIGN-data） ── */
const C = {
  brandOrange: 'FFFF6B35',
  brandInk: 'FFCC4413',
  navy: 'FF1A365D',
  white: 'FFFFFFFF',
  text: 'FF0F172A',
  sub: 'FF334155',
  grid: 'FFD8DCE3',
  inputFill: 'FFFEF5DC',
  inputText: 'FF854D0E',
  neutralFill: 'FFEEF0F4',
  neutralText: 'FF475569',
  groupFill: 'FFE8EDF3',
};
const CJK = '等线';
const LATN = 'Consolas';
const INPUT_ROWS = 200;
const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin' as const, color: { argb: C.grid } };
const grid: Partial<ExcelJS.Borders> = { top: thin, left: thin, bottom: thin, right: thin };
const today = '2026-11-04';

function titleArea(ws: ExcelJS.Worksheet, title: string, subtitle: string) {
  ws.getColumn(1).width = 1.5;
  ws.getCell('A1').fill = fill(C.brandOrange); // 品牌准入位 1：标题行左侧色块
  const t = ws.getCell('B1');
  t.value = title;
  t.font = { name: CJK, size: 14, bold: true, color: { argb: C.navy } };
  const s = ws.getCell('B2');
  s.value = subtitle;
  s.font = { name: CJK, size: 9, color: { argb: C.sub } };
}

function headerCell(cell: ExcelJS.Cell, col: Column) {
  cell.value = `${col.required ? '★ ' : ''}${col.label}`;
  cell.font = { name: CJK, size: 11, bold: true, color: { argb: C.white } };
  cell.fill = fill(C.navy);
  cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  cell.border = { ...grid, bottom: { style: 'medium', color: { argb: C.navy } } };
}

function dataCell(cell: ExcelJS.Cell, col: Column, kind: 'example' | 'input') {
  const isNum = col.type === 'number';
  cell.font = {
    name: isNum ? LATN : CJK,
    size: 10,
    color: { argb: kind === 'example' ? C.neutralText : C.inputText },
    italic: kind === 'example',
  };
  cell.fill = fill(kind === 'example' ? C.neutralFill : C.inputFill);
  cell.alignment = { horizontal: isNum ? 'right' : 'left', vertical: 'middle', wrapText: col.width !== undefined && col.width >= 30 };
  cell.border = grid;
  if (col.type === 'choice' && col.choices && kind === 'input') {
    cell.dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [`"${col.choices.join(',')}"`],
      showErrorMessage: true,
      errorTitle: '请从下拉框里选',
      error: `只能填：${col.choices.join(' / ')}`,
    };
  }
}

/** 表格式：第 4 行表头，第 5 行示例，第 6 行起手填 */
function tableSheet(wb: ExcelJS.Workbook, title: string, sheet: Sheet) {
  const ws = wb.addWorksheet(sheet.name, { views: [{ state: 'frozen', xSplit: 1, ySplit: 4 }] });
  titleArea(ws, `${title} · ${sheet.name}`, `${sheet.purpose}。带 ★ 的列必填。灰色那一行是示例，系统会忽略，从下一行开始填。`);
  const cols = sheet.columns!;
  cols.forEach((col, i) => {
    const c = i + 2;
    ws.getColumn(c).width = col.width ?? 14;
    headerCell(ws.getCell(4, c), col);
    const ex = ws.getCell(5, c);
    ex.value = col.example === '' || col.example === undefined ? null : col.example;
    dataCell(ex, col, 'example');
    for (let r = 6; r < 6 + INPUT_ROWS; r += 1) dataCell(ws.getCell(r, c), col, 'input');
  });
  ws.getRow(4).height = 28;
  ws.getCell(5, 1).value = null;
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:4' };
}

/** 逐行式：一行一个项目，C 列手填 */
function rowsSheet(wb: ExcelJS.Workbook, title: string, sheet: Sheet) {
  const ws = wb.addWorksheet(sheet.name, { views: [{ state: 'frozen', xSplit: 1, ySplit: 4 }] });
  titleArea(ws, title, `${sheet.purpose}。在「填写内容（手填）」那一列填，灰色的示例列不用动。`);
  const heads: Column[] = [
    { key: 'label', label: '项目', type: 'text', width: 20 },
    { key: 'value', label: '填写内容（手填）', type: 'text', width: 42 },
    { key: 'example', label: '示例', type: 'text', width: 36 },
  ];
  heads.forEach((h, i) => {
    ws.getColumn(i + 2).width = h.width!;
    headerCell(ws.getCell(4, i + 2), h);
  });
  ws.getRow(4).height = 28;
  sheet.rows!.forEach((row, i) => {
    const r = 5 + i;
    const label = ws.getCell(r, 2);
    label.value = row.label;
    label.font = { name: CJK, size: 10, bold: true, color: { argb: C.text } };
    label.border = grid;
    const v = ws.getCell(r, 3);
    dataCell(v, { ...row, width: 42 }, 'input');
    const ex = ws.getCell(r, 4);
    ex.value = row.hint ? `${row.example ?? ''}（${row.hint}）` : (row.example ?? null);
    dataCell(ex, { ...row, type: 'text', width: 36 }, 'example');
  });
}

function legendSheet(wb: ExcelJS.Workbook, file: TemplateSpec['files'][number]) {
  const ws = wb.addWorksheet('填写说明');
  titleArea(ws, `${file.title} · 填写说明`, '先看这一页，再去前面的表里填。');
  ws.getColumn(2).width = 100;
  let r = 4;
  const line = (text: string, opts: { bold?: boolean; fillArgb?: string; color?: string } = {}) => {
    const c = ws.getCell(r, 2);
    c.value = text;
    c.font = { name: CJK, size: 10, bold: opts.bold, color: { argb: opts.color ?? C.sub } };
    if (opts.fillArgb) c.fill = fill(opts.fillArgb);
    c.alignment = { wrapText: true, vertical: 'middle' };
    r += 1;
  };
  line('颜色是什么意思', { bold: true, fillArgb: C.groupFill, color: C.navy });
  line('淡黄底：给你填的格子', { fillArgb: C.inputFill, color: C.inputText });
  line('灰底斜体：示例，系统会忽略，不用删', { fillArgb: C.neutralFill, color: C.neutralText });
  line('藏蓝底白字：列名。带 ★ 的列必须填', { fillArgb: C.navy, color: C.white });
  r += 1;
  for (const sheet of file.sheets) {
    line(`「${sheet.name}」：${sheet.purpose}`, { bold: true, fillArgb: C.groupFill, color: C.navy });
    for (const col of sheet.columns ?? sheet.rows ?? []) {
      const parts = [`${col.required ? '★ ' : ''}${col.label}`];
      if (col.hint) parts.push(col.hint);
      if (col.choices) parts.push(`只能选：${col.choices.join(' / ')}`);
      if (col.type === 'number') parts.push('填数字');
      line(parts.join(' —— '), { color: C.text });
    }
    r += 1;
  }
  line('注意', { bold: true, fillArgb: C.groupFill, color: C.navy });
  line('· 不需要填公司真实名称、员工姓名、客户名单。', { color: C.text });
  line('· 表名、列名不要改，系统按名字读取。不要插入或删除列，也不要隐藏行列。', { color: C.text });
  line('· 没有的信息空着就行，系统会从聊天记录里推断；推断不出的地方会让主管用选择题确认。', { color: C.text });
  r += 1;
  // 品牌准入位 2：页尾署名
  const f = ws.getCell(r, 2);
  f.value = {
    richText: [
      { text: '王铖运营社', font: { name: CJK, size: 9, color: { argb: C.brandInk } } },
      { text: ` · ${file.title} · ${today}`, font: { name: CJK, size: 9, color: { argb: C.sub } } },
    ],
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const file of spec.files) {
    const wb = new ExcelJS.Workbook();
    // 文档属性不留个人信息
    wb.creator = 'STC';
    wb.lastModifiedBy = 'STC';
    wb.company = '';
    wb.created = new Date(`${today}T00:00:00Z`);
    wb.modified = new Date(`${today}T00:00:00Z`);
    for (const sheet of file.sheets) {
      if (sheet.layout === 'rows') rowsSheet(wb, file.title, sheet);
      else tableSheet(wb, file.title, sheet);
    }
    legendSheet(wb, file);
    await wb.xlsx.writeFile(join(OUT_DIR, file.file_name));
    console.log(`✓ ${file.file_name}`);
  }
}
main();
