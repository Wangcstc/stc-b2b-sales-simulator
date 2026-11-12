/**
 * 忠实度闸：暗牌是素材里真有的，还是编的（判定逻辑在抽屉的质检工序里，这里只是命令行外壳）。
 *
 *   npx tsx scripts/import/verify-fidelity.ts <题库包目录或题目文件> [--materials=<脱敏素材目录>] [--strict]
 *   不写路径时读环境变量 BANK_DIR
 *
 * 每道题在 `_source` 里交代每张暗牌的出处：出自素材第几条消息的哪句原话，或者标明是补写的并写理由。
 * 素材按 `_source.material_id` 到素材目录里找 `<material_id>/redacted.json`（默认 imports/）。
 *
 * ★ 宽松模式只查写了 `_source` 的题 ★ 手写的老题多数没有出处，第一次打开就一百多行红字等于没有检测。
 * ★ 新题一律 `--strict` ★ 每张暗牌都要对自己的来历表态——来自素材，或者写明为什么补。
 * ★ 素材不在本机不算题的错 ★ 素材目录在 .gitignore 里，换台机器就没有，这种情况跳过并说明。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkFidelity, type Material } from '../../drawer/index';
import type { Persona } from '../../bank-kit/index';

function loadMaterial(dir: string, id: string | null | undefined): Material | null {
  if (!id) return null;
  const path = join(dir, id, 'redacted.json');
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { chat?: { messages?: { text?: string; textCn?: string }[] } };
  const messages = raw.chat?.messages ?? [];
  return { text: messages.map((m) => m.text ?? ''), textCn: messages.map((m) => m.textCn ?? '') };
}

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const materials = args.find((a) => a.startsWith('--materials='))?.slice('--materials='.length) ?? 'imports';
  const inputs = args.filter((a) => !a.startsWith('--'));
  if (inputs.length === 0 && process.env.BANK_DIR) inputs.push(process.env.BANK_DIR);
  if (inputs.length === 0) {
    console.log('用法：npx tsx scripts/import/verify-fidelity.ts <题库包目录或题目文件> [--materials=<脱敏素材目录>] [--strict]');
    process.exit(1);
  }
  const targets = inputs.flatMap((p) => {
    if (!statSync(p).isDirectory()) return [p];
    const dir = existsSync(join(p, 'personas')) ? join(p, 'personas') : p;
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f));
  });

  console.log(`\n忠实度闸 ｜ ${targets.length} 道题 ｜ ${strict ? '严格模式：每张暗牌都必须交代出处' : '宽松模式：只查写了出处的'} ｜ 素材目录 ${materials}/\n`);
  let bad = 0;
  let warn = 0;
  let checkedCards = 0;
  let skipped = 0;

  for (const file of targets) {
    const p = JSON.parse(readFileSync(file, 'utf8')) as Persona;
    if (!p._source && !strict) {
      skipped += 1;
      continue;
    }
    const quotes = p._source?.quotes ?? [];
    const needsMaterial = quotes.some((q) => !q.invented);
    const material = loadMaterial(materials, p._source?.material_id);
    if (needsMaterial && !material) {
      console.log(`  · ${p.id.padEnd(14)} 素材 ${p._source?.material_id ?? '（未写编号）'} 不在本机，跳过`);
      skipped += 1;
      continue;
    }
    const r = checkFidelity(p, material, strict);
    checkedCards += r.checked;
    if (!r.problems.length) {
      console.log(`  ✓ ${p.id.padEnd(14)} 有出处 ${r.checked} 张${r.invented ? ` ｜ 标注为补写 ${r.invented} 张` : ''}`);
      continue;
    }
    console.log(`  ${p.id}`);
    for (const x of r.problems) {
      console.log(`    ${x.level} ${x.what}`);
      if (x.level === '✗') bad += 1;
      else warn += 1;
    }
  }

  console.log(`\n───── 忠实度闸完成：核对暗牌 ${checkedCards} 张 ｜ 硬问题 ${bad} 处 ｜ 提醒 ${warn} 处 ｜ 跳过 ${skipped} 道 ─────`);
  process.exit(bad === 0 ? 0 : 1);
}

main();
