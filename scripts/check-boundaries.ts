/**
 * 模块依赖方向检查（`npm run check:boundaries`）。规则见 `boundaries.ts`。违反任何一条就 exit 1。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findQuestionIds, findViolations, type SourceFile } from './boundaries';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['standards', 'engine', 'bank-kit', 'drawer', 'src', 'scripts'];
const files: SourceFile[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules' && name !== '_dist') walk(p);
    } else if (/\.(ts|tsx|mts|mjs)$/.test(name)) {
      files.push({ path: relative(ROOT, p).split('\\').join('/'), content: readFileSync(p, 'utf8') });
    }
  }
};
for (const d of DIRS) {
  try {
    if (statSync(join(ROOT, d)).isDirectory()) walk(join(ROOT, d));
  } catch {
    /* 模块还不存在（例如抽屉尚未建） */
  }
}
const violations = [...findViolations(files), ...findQuestionIds(files)];
for (const v of violations) console.log(`✗ ${v.file}：${v.spec} —— ${v.rule}`);
console.log(violations.length ? `\n✗ 模块边界检查不通过：${violations.length} 处` : `✓ 模块边界检查通过：${files.length} 个源文件，依赖方向全部单向`);
process.exit(violations.length ? 1 : 0);
