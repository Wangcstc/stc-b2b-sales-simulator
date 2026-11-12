/**
 * 存储隔离核查（需求 1.3 铁律 / 步骤 48）
 *
 * ★ 演习系统永不写入 wang-grade-coach-memory ★
 * 违反后果：演习分混进正式定级样本池，造出一批"纸上谈兵"的高分业务员——
 * 七力漂亮、真实商机零推进。v6.0 第 13 章使用红线已明令禁止。
 *
 * 这个脚本扫源码里有没有任何写入那个目录的路径。CI 里应当是硬失败。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN = /wang-grade-coach-memory/;
/** 只解释"为什么禁止"的地方允许提到它 */
const ALLOW = ['scripts/check-isolation.ts', 'prisma/schema.prisma', 'README.md', 'docs/BUILD_STEPS.md'];

let hits = 0;

function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.next', '.git', 'coverage', 'p0'].includes(name)) continue;
    const p = join(dir, name);
    const rel = p.slice(ROOT.length + 1).replaceAll('\\', '/');
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.(ts|tsx|js|mjs|json|prisma|yml)$/.test(name)) continue;
    if (ALLOW.includes(rel)) continue;
    readFileSync(p, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!FORBIDDEN.test(line)) return;
        // 注释里提到它是在解释「为什么禁止」，不是写入路径。
        // 真正的写入一定是代码，不会是注释。
        const t = line.trim();
        if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('#')) return;
        console.log(`✗ ${rel}:${i + 1}　${line.trim().slice(0, 120)}`);
        hits += 1;
      });
  }
}

walk(ROOT);
console.log(hits === 0 ? '✓ 通过：代码中不存在任何写入 wang-grade-coach-memory 的路径' : `✗ 发现 ${hits} 处`);
process.exit(hits === 0 ? 0 : 1);
