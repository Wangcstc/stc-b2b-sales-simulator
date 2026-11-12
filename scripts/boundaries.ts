/**
 * 模块边界规则（高内聚、低耦合）—— 纯函数，`check-boundaries.ts` 读文件后调用它。
 *
 *   standards/  标准层：零依赖。只许引用 standards/ 自己里面的文件
 *   engine/     判定引擎：纯函数。只许依赖标准层；柜子、抽屉、脚本都可以用它
 *   bank-kit/   题库工具包：只许依赖标准层（standards/index 或 standards/schema/*.json）、node 内建、ajv
 *   drawer/     抽屉：不许引用柜子（src/），其余模块只许走公开入口
 *   src/        柜子：引用题库工具包、抽屉只许走公开入口（bank-kit/index、drawer/index、浏览器端的 drawer/browser）
 *   scripts/    脚本：引用题库工具包、抽屉同样只许走公开入口
 *
 * 任何模块都不许反向依赖：标准层不认识任何人；题库工具包不认识柜子和抽屉；抽屉不认识柜子。
 */
import { posix } from 'node:path';

export type Module = 'standards' | 'engine' | 'bank-kit' | 'drawer' | 'src' | 'scripts' | 'samples' | 'other';

export interface SourceFile {
  /** 相对项目根目录、用 / 分隔的路径 */
  path: string;
  content: string;
}

export interface Violation {
  file: string;
  spec: string;
  rule: string;
}

export function moduleOf(path: string): Module {
  const top = path.split('/')[0];
  return (['standards', 'engine', 'bank-kit', 'drawer', 'src', 'scripts', 'samples'] as const).find((m) => m === top) ?? 'other';
}

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

export function importsOf(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(IMPORT_RE)) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}

/** 把一条 import 说明符解析成项目内的路径；包名和 node 内建返回 null */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (spec.startsWith('@/')) return posix.normalize(`src/${spec.slice(2)}`);
  if (spec.startsWith('.')) return posix.normalize(posix.join(posix.dirname(fromFile), spec));
  return null;
}

/**
 * 公开入口。抽屉有两个：`drawer/index`（整条流水线，只能在服务端跑）和
 * `drawer/browser`（只有解析与脱敏，给题库工坊的投料页在浏览器里跑）。
 */
const isIndex = (target: string, mod: string) =>
  (/^(bank-kit|drawer|standards)\/index(\.ts)?$/.test(target) || /^drawer\/browser(\.ts)?$/.test(target)) && target.startsWith(mod);

/** 具体题目编号：题库格式 v1（A09-PL-001）与旧格式（P22-EX-001、P1-V1） */
const QUESTION_ID = /\b(?:[A-G]\d{2}-[A-Z]{2}-\d{3}|P\d{1,2}-(?:V\d|EX(?:-\w+)?|[A-Z]{2}-\d{3}))\b/;

/**
 * 柜子不认识任何具体题目：src/ 里（测试文件除外，测试数据是虚构的）不许出现题目编号，注释也不行。
 * 注释里写着某道题，读代码的人就会以为柜子依赖它；题库一换，这句注释就成了谎话。
 */
export function findQuestionIds(files: SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (moduleOf(f.path) !== 'src' || /\.test\.tsx?$/.test(f.path)) continue;
    f.content.split('\n').forEach((line, i) => {
      const m = QUESTION_ID.exec(line);
      if (m) out.push({ file: `${f.path}:${i + 1}`, spec: m[0], rule: '柜子里不许出现具体题目编号' });
    });
  }
  return out;
}

export function findViolations(files: SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    const from = moduleOf(f.path);
    for (const spec of importsOf(f.content)) {
      const target = resolveSpec(f.path, spec);
      const v = (rule: string) => out.push({ file: f.path, spec, rule });

      if (target === null) {
        // 第三方包与 node 内建。测试文件可以用测试框架和 node 内建，模块方向规则对它照样生效
        if (/\.test\.tsx?$/.test(f.path)) continue;
        if (from === 'standards') v('标准层零依赖：不许引用任何包或 node 内建');
        if (from === 'engine') v('判定引擎是纯函数：不许引用任何包或 node 内建');
        if (from === 'bank-kit' && !spec.startsWith('node:') && spec !== 'ajv') v('题库工具包只许依赖 node 内建与 ajv');
        continue;
      }
      const to = moduleOf(target);
      if (to === from) continue;

      if (from === 'standards') v('标准层零依赖：不许引用标准层以外的任何文件');
      else if (from === 'engine') {
        if (to !== 'standards') v('判定引擎只许依赖标准层');
      }
      else if (from === 'bank-kit') {
        if (to !== 'standards') v('题库工具包只许依赖标准层');
        else if (!/^standards\/(index(\.ts)?|schema\/[^/]+\.schema\.json)$/.test(target)) v('引用标准层只许走 standards/index 或 standards/schema/*.json');
      } else if (from === 'drawer') {
        if (to === 'src') v('抽屉不许引用柜子（src/）');
        else if ((to === 'bank-kit' || to === 'standards') && !isIndex(target, to) && !/^standards\/schema\//.test(target)) {
          v(`引用 ${to} 只许走公开入口 ${to}/index`);
        }
      } else if (from === 'src' || from === 'scripts') {
        if ((to === 'bank-kit' || to === 'drawer') && !isIndex(target, to)) v(`引用 ${to} 只许走公开入口 ${to}/index`);
        if (to === 'standards' && !isIndex(target, 'standards') && !/^standards\/(schema|syllabus|templates)\//.test(target)) {
          v('引用标准层只许走 standards/index，或直接读它的数据文件');
        }
        if (from === 'src' && to === 'scripts') v('柜子不许引用 scripts/');
      }
    }
  }
  return out;
}
