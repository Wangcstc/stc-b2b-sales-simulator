/**
 * 一道题的暗牌解锁正则与泄露信号自检（判定逻辑在抽屉的质检工序里，这里只是命令行外壳）。
 *
 *   npx tsx scripts/import/verify-persona.ts <题库包>/personas/〈题型〉-〈国家〉-〈序号〉.json
 *
 * 查六件事：正则转义完好、泄露信号不含正则语法、普通话术不被判成泄露、普通问法不白送暗牌、
 * 每张牌的正反例全过、干扰项与开场询盘自己不泄露暗牌。
 * 不调模型、不连库，纯跑判定引擎的 detectUnlocks / checkLeak。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cardsOf, checkRegex, type Problem } from '../../drawer/index';
import type { Persona } from '../../bank-kit/index';

function main() {
  const file = process.argv[2];
  if (!file) {
    console.log('用法：npx tsx scripts/import/verify-persona.ts <题目文件.json>');
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(resolve(file), 'utf8')) as Persona & { persona_variant_id?: string; _verify_cases?: Persona['verify_cases'] };
  // 旧格式的字段名兼容
  const persona = { ...raw, verify_cases: raw.verify_cases ?? raw._verify_cases ?? [] } as Persona;
  console.log(`\n题目 ${raw.id ?? raw.persona_variant_id}　暗牌 ${Object.keys(cardsOf(persona)).length} 张`);
  const problems: Problem[] = checkRegex(persona);
  for (const p of problems) console.log(`  ${p.level} ${p.what}`);
  const fail = problems.filter((p) => p.level === '✗').length;
  console.log(fail === 0 ? `\n✅ 全部通过${problems.length ? `（${problems.length} 条提醒）` : ''}\n` : `\n❌ ${fail} 处需要修\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
