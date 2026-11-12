/**
 * 背调资料包自检 + 覆盖率
 *
 *   npx tsx scripts/import/verify-bg.ts <题库包目录>              全部包 + 覆盖率
 *   npx tsx scripts/import/verify-bg.ts <题库包目录> A03-KE-001   只查一份
 * 不写目录时读环境变量 BANK_DIR。
 *
 * ★ 为什么现在才有这道闸 ★（2026-08-28）
 * 人设有两道闸（verify-persona / autoplay），**背调包一道都没有**。
 * 而它比人设更容易坏得无声无息：
 *   · 预埋错误的 `truth` 和 `claim` 说的是同一件事 → 这个包没有考点，但界面一切正常；
 *   · `detectable_via` 指着一个包里根本不存在的材料 → 新人怎么查都查不出来，
 *     报告还会说他"没识破"；
 *   · 写给出题人看的话忘了加下划线前缀 → **答案直接发到浏览器**
 *     （2026-08-08 那次 F12 就能读到 planted_error 的事故，剥壳层挡的是已知的两类，
 *     挡不住一个叫 `answer_note` 的新字段）。
 * 三种都不会抛异常。所以它们只能靠这个脚本拦。
 *
 * ★ 剥壳这一条查的是「有没有漏网的答案字段」★ `bg-package.stripAnswers` 只认
 * 下划线开头的键与 `planted_error` 整块。规矩本身没问题，问题是它**靠命名自觉**——
 * 这里把全包扫一遍，凡是名字里带 note/hint/answer/truth/design/decision 却没有下划线
 * 前缀的键，一律报出来。宁可误报，也不能让一个答案字段悄悄发出去。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkBgPackage, type BgPackageShape, type Problem } from '../../drawer/index';
import type { Persona } from '../../bank-kit/index';

const BANK = process.argv.slice(2).find((a) => !a.startsWith('--') && existsSync(a)) ?? process.env.BANK_DIR;
if (!BANK) {
  console.log('用法：npx tsx scripts/import/verify-bg.ts <题库包目录> [题目编号…]');
  process.exit(1);
}
const BG_DIR = join(BANK, 'bg-packages');
const PERSONA_DIR = join(BANK, 'personas');

/** 判定在抽屉的质检工序里（drawer/qa/bg.ts）；这里只补「文件层面」的两项：挂的题存在、文件名对得上 */
function checkPackage(file: string, personas: Map<string, Persona>): Problem[] {
  const pkg = JSON.parse(readFileSync(join(BG_DIR, file), 'utf8')) as BgPackageShape;
  const vid = pkg.persona_id ?? pkg.variant_id;
  if (!vid) return [{ level: '✗', what: '没有 persona_id，装入时不知道该挂给哪道题' }];
  const problems: Problem[] = [];
  if (!personas.has(vid)) problems.push({ level: '✗', what: `挂的题 ${vid} 不存在` });
  if (file !== `${vid}.json`) problems.push({ level: '⚠', what: `文件名与 persona_id 不一致（${file} vs ${vid}）` });
  return [...problems, ...checkBgPackage(pkg, personas.get(vid))];
}

function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== BANK);
  const files = readdirSync(BG_DIR).filter((f) => f.endsWith('.json'));
  const targets = only.length > 0 ? files.filter((f) => only.some((o) => f.startsWith(o))) : files;

  const personas = readdirSync(PERSONA_DIR).filter((f) => f.endsWith('.json'));
  /**
   * ★ 认的是文件里的 `persona_variant_id`，不是文件名 ★
   * 第一版拿文件名当 id，于是 P3-GH-001 / P12-NG-001 / P6-PK-001 / P7-US-001 四份
   * 全被报成「人设不存在」——它们的人设确实在，只是文件名与变体号不一样。
   * seed 也是按 variant_id 查库的（`findUnique({ where: { variantId } })`），
   * 这里必须跟它同一个口径，否则这道闸报的是它自己的 bug。
   */
  const byId = new Map(
    personas.map((f) => {
      const p = JSON.parse(readFileSync(join(PERSONA_DIR, f), 'utf8')) as Persona & { persona_variant_id?: string };
      return [p.id ?? p.persona_variant_id ?? f.replace(/\.json$/, ''), p] as const;
    }),
  );

  console.log(`\n背调包自检 ｜ ${targets.length} 份\n`);
  let bad = 0;
  let warn = 0;
  for (const file of targets) {
    const problems = checkPackage(file, byId);
    if (problems.length === 0) {
      console.log(`  ✓ ${file.replace(/\.json$/, '')}`);
      continue;
    }
    console.log(`  ${file.replace(/\.json$/, '')}`);
    for (const p of problems) {
      console.log(`    ${p.level} ${p.what}`);
      if (p.level === '✗') bad += 1;
      else warn += 1;
    }
  }

  /* ── 覆盖率：哪个槽位缺背调包 ── */
  if (only.length === 0 && existsSync(PERSONA_DIR)) {
    const covered = new Set(targets.map((f) => f.replace(/\.json$/, '')));
    const slots = new Map<string, { total: number; has: number; missing: string[] }>();
    for (const file of personas) {
      const raw = JSON.parse(readFileSync(join(PERSONA_DIR, file), 'utf8')) as {
        id?: string;
        persona_variant_id?: string;
        exam_only?: boolean;
        pool_type?: string;
        difficulty?: string;
        skeleton: { session_type: string; difficulty: string };
      };
      const p = {
        ...raw,
        persona_variant_id: raw.id ?? raw.persona_variant_id ?? file,
        exam_only: raw.exam_only ?? raw.pool_type === 'admission_exam',
        skeleton: { ...raw.skeleton, difficulty: raw.difficulty ?? raw.skeleton.difficulty },
      };
      if (!p.exam_only) continue; // 覆盖率只盯考试池——演习局缺背调包不影响判定
      const slot =
        p.skeleton.session_type === 'followup'
          ? '跟进'
          : p.skeleton.difficulty === 'hard'
            ? '探需·困难'
            : '探需·标准';
      const row = slots.get(slot) ?? { total: 0, has: 0, missing: [] };
      row.total += 1;
      if (covered.has(p.persona_variant_id)) row.has += 1;
      else row.missing.push(p.persona_variant_id);
      slots.set(slot, row);
    }
    console.log('\n── 考试池的背调包覆盖 ──');
    for (const [slot, row] of slots) {
      console.log(`  ${slot.padEnd(8)} ${row.has}/${row.total}` + (row.missing.length ? `　缺：${row.missing.join('、')}` : ''));
    }
    console.log('  （演习池不计入：缺背调包不影响判定，缺在考试池才是考点直接消失）');
  }

  console.log(`\n───── 背调包自检完成：硬问题 ${bad} 处 ｜ 提醒 ${warn} 处 ─────`);
  process.exit(bad === 0 ? 0 : 1);
}

main();
