/**
 * 自动对局：拿引擎把每一局机器打一遍，检查「这一局到底打不打得通」
 *
 *   BANK_DIR=<题库包> npx tsx scripts/import/autoplay.ts  跑整个题库
 *   npx tsx scripts/import/autoplay.ts <题库包>/personas/A01-US-001.json   跑一份
 *   npx tsx scripts/import/autoplay.ts <题库包>/personas         跑一个目录（题库格式 v1 也认）
 *   加 --json：逐份输出机器可比对的结果（迁移前后零差异验证用）
 *
 * ★ 为什么要有这个东西 ★
 * `verify-persona.ts` 查的是**单条正则**对不对：该解锁的解不解锁、普通话会不会白送。
 * 它查不出整局层面的问题——
 *   · 某张暗牌的 requires 链根本走不通，这局永远拿不到那张牌；
 *   · 一个好新人规规矩矩打，耐心值第 5 轮就归零，局直接结束；
 *   · 六要素在这一局压根收不齐，洞察力必然被判低分，而那不是新人的错；
 *   · 客户扮演会说出来的话（exit_lines / quote_reactions / 干扰项）自己泄露了暗牌。
 * 这些错误在真人跑一局时五分钟就会撞上，但没人跑就永远躺在那里。
 *
 * ★ 它替代不了真人 ★
 * 机器打的是「设计者自己写的标准问法」（`_verify_cases[].should`），
 * 等于拿答案去考试——只能证明这局**存在一条通路**，不能证明难度合适、话像不像人。
 * 所以它的定位是**下限闸**：过不了的一定有问题，过了的仍需真人验一局。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  runAutoplay as run,
  toAutoplayShape as normalize,
  type AutoplayPersona as Persona,
  type Problem,
} from '../../drawer/index';
import { bandOfLabel, MIN_BAND_GAP, type DifficultyBreakdown } from '../../engine/difficulty-index.js';

function main() {
  const report = process.argv.includes('--report');
  const asJson = process.argv.includes('--json');
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const fallback = process.env.BANK_DIR ? join(process.env.BANK_DIR, 'personas') : null;
  if (!arg && !fallback) {
    console.log('用法：npx tsx scripts/import/autoplay.ts <题库包>/personas | <题目文件.json> [--report] [--json]（或设环境变量 BANK_DIR）');
    process.exit(1);
  }
  const dir = arg && statSync(arg).isDirectory() ? arg : !arg ? fallback : null;
  const files = !dir
    ? [arg as string]
    : readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => join(dir, f));
  const jsonRows: { id: string; problems: Problem[]; difficulty: DifficultyBreakdown | null }[] = [];

  let bad = 0;
  let warn = 0;
  const lines: string[] = [];
  const measured: { persona: Persona; difficulty: DifficultyBreakdown | null }[] = [];

  for (const f of files) {
    let p: Persona;
    try {
      p = normalize(JSON.parse(readFileSync(f, 'utf8')) as Persona);
    } catch (e) {
      console.log(`✗ ${f} JSON 读不了：${(e as Error).message}`);
      bad++;
      continue;
    }
    const { problems: probs, difficulty } = run(p);
    measured.push({ persona: p, difficulty });
    jsonRows.push({ id: p.persona_variant_id, problems: probs, difficulty });
    const errs = probs.filter((x) => x.level === '✗');
    const warns = probs.filter((x) => x.level === '⚠');
    bad += errs.length;
    warn += warns.length;
    const tag = errs.length ? '✗' : warns.length ? '⚠' : '✓';
    lines.push(
      `${tag} ${p.persona_variant_id.padEnd(14)} ${p.skeleton.code.padEnd(4)} ${p.skeleton.name.padEnd(12)} ${p.exam_only ? '考试' : '演习'}  牌${Object.keys(p.hidden_card ?? {}).length}` +
        `  难度${difficulty ? String(difficulty.index).padStart(3) : ' －'}` +
        (probs.length ? '' : '  一切正常'),
    );
    for (const x of probs) lines.push(`    ${x.level} ${x.what}`);
  }

  /**
   * ★ --report：只看难度，不看问题 ★（2026-08-28 第三批）
   * 给「标签跟着量走」这件事一张能摆在王老师面前的表：全池分布、声明档 × 实测档的混淆矩阵、
   * 同一考点内部拉开了多少。**它只报，不改任何文件**——改档会改变考试槽位的份数，
   * 而考试池有「每槽 ≥14 份、≥4 个考点」的硬门槛，自动改档可能让某个槽当场跌破门槛。
   */
  if (asJson) {
    console.log(JSON.stringify(jsonRows, null, 2));
    process.exit(bad ? 1 : 0);
  }

  if (report) {
    const rows = measured
      .filter((m) => m.difficulty)
      .map((m) => ({
        id: m.persona.persona_variant_id,
        code: m.persona.skeleton.code,
        exam: Boolean(m.persona.exam_only),
        declared: bandOfLabel(m.persona.skeleton.difficulty),
        index: m.difficulty!.index,
        parts: m.difficulty!.parts,
      }))
      .sort((a, b) => a.index - b.index);

    const out: string[] = ['', '═════ 机制难度指数 · 全池分布 ═════', ''];
    for (const band of ['simple', 'standard', 'hard'] as const) {
      const group = rows.filter((r) => r.declared === band);
      if (!group.length) continue;
      const idx = group.map((r) => r.index).sort((a, b) => a - b);
      out.push(
        `声明「${band}」 ${String(group.length).padStart(3)} 份 ｜ 实测 ${idx[0]}–${idx[idx.length - 1]} ｜ 中位 ${idx[Math.floor(idx.length / 2)]}`,
      );
    }

    /**
     * ★ 这里原来有一张「声明档位 × 实测档位」的混淆矩阵，删了 ★
     * 绝对分界撤掉之后，那张表只能拿声明档位跟自己比，出来是一条完美的对角线——
     * **看起来像"标签和实测完全一致"，而事实恰恰相反。**
     * 一张会说反话的表比没有表更糟。分布那三行已经把该说的说清楚了。
     */
    out.push('', '── 同一考点内部：指数跨度够不够拉开两档 ──');
    const byCode = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byCode.get(r.code) ?? [];
      list.push(r);
      byCode.set(r.code, list);
    }
    for (const [code, list] of [...byCode].sort((a, b) => a[0].localeCompare(b[0]))) {
      const idx = list.map((r) => r.index);
      const spread = Math.max(...idx) - Math.min(...idx);
      if (spread >= MIN_BAND_GAP) {
        out.push(`  ${code.padEnd(4)} ${list.length} 份，指数 ${Math.min(...idx)}–${Math.max(...idx)}（跨度 ${spread}）★ 够拉开两档 ★`);
      }
    }

    out.push('', '── 逐份（按指数升序）──');
    for (const r of rows) {
      out.push(
        `  ${String(r.index).padStart(3)}  ${r.id.padEnd(14)} ${r.code.padEnd(4)} ${r.exam ? '考试' : '演习'}` +
          `  档位${r.declared.padEnd(9)}` +
          `  长度${String(r.parts.length).padStart(3)} 耐心${String(r.parts.burn).padStart(3)} 卡住${String(r.parts.blocked).padStart(3)} 结构${String(r.parts.structure).padStart(3)}`,
      );
    }
    out.push('', `───── ${rows.length} 份 ─────`);
    out.push('★ 指数不是档位标签 ★ 标签量的是认知难度（这个考点难不难想明白），');
    out.push('  指数量的是机制难度（跑通要几轮、耗多少容错）。两把尺不是同一个东西——');
    out.push('  实测：声明「简单」的那 18 份机制上最重（中位 50），「标准」最轻（中位 34）。');
    out.push('  所以这里只给分布，不判谁该是哪一档。改档是人的事，而且会改变考试槽位份数。');
    console.log(out.join('\n'));
    process.exit(0);
  }

  /**
   * ★ 闸 ⑧：声明了档位覆盖的变体，必须真的跟兄弟拉开 ★（2026-08-28 第三批）
   *
   * 「难度下沉到变体」解开的是供给瓶颈：同一个考点能出标准和困难两档，
   * 不用新写考点。但它同时开了一个新口子——**写一个 `difficulty: "hard"` 就能声称
   * 自己是困难题**，而机制上跟标准版一模一样。那样困难槽名义上有题，
   * 实际考的是标准难度，而「困难局撑不撑得住」正是准入要判的东西。
   *
   * 所以：只要变体声明的档位与骨架不同，就去看它和**同考点、没声明覆盖的那些兄弟**
   * 的机制难度指数差了多少。差不到 `MIN_BAND_GAP` 就是硬问题。
   *
   * ★ 只查声明了覆盖的 ★ 没声明的变体跟着骨架走，本来就不该被这条管。
   * 这也是为什么它必须在 main() 里做：run() 一次只看一份，看不到兄弟。
   */
  if (!report) {
    const byCode = new Map<string, typeof measured>();
    for (const m of measured) {
      const list = byCode.get(m.persona.skeleton.code) ?? [];
      list.push(m);
      byCode.set(m.persona.skeleton.code, list);
    }
    for (const m of measured) {
      const declared = m.persona.difficulty;
      if (!declared || !m.difficulty) continue;
      if (bandOfLabel(declared) === bandOfLabel(m.persona.skeleton.difficulty)) continue;

      const siblings = (byCode.get(m.persona.skeleton.code) ?? []).filter(
        (x) => x !== m && !x.persona.difficulty && x.difficulty,
      );
      if (siblings.length === 0) {
        console.log(
          `⚠ ${m.persona.persona_variant_id} 声明了档位覆盖「${declared}」，但这个考点没有别的变体可比——` +
            `拉没拉开无从验证，先找个同考点的标准档变体一起入库`,
        );
        warn += 1;
        continue;
      }
      const base = siblings.map((x) => x.difficulty!.index).sort((a, b) => a - b);
      const baseline = base[Math.floor(base.length / 2)]!;
      const gap = Math.abs(m.difficulty.index - baseline);
      if (gap < MIN_BAND_GAP) {
        console.log(
          `✗ ${m.persona.persona_variant_id} 声明「${declared}」（骨架是「${m.persona.skeleton.difficulty}」），` +
            `但机制难度只差 ${gap} 分（本份 ${m.difficulty.index}，同考点其他变体中位 ${baseline}，至少要差 ${MIN_BAND_GAP}）。` +
            `\n    换汤不换药的「困难版」会让困难槽名义上有题、实际考的是标准难度。` +
            `\n    调这几个旋钮把它真做难：暗牌张数与 requires 链深度、解锁改成 topic+framing 双组、开局耐心、干扰项密度。`,
        );
        bad += 1;
      }
    }
  }

  console.log(lines.join('\n'));
  console.log(`\n───── 自动对局完成：${files.length} 局 ｜ 硬问题 ${bad} 处 ｜ 提醒 ${warn} 处 ─────`);
  console.log('★ 机器打的是设计者自己写的标准问法，等于拿答案考试 ★');
  console.log('  它只能证明这局存在一条通路。难度合不合适、话像不像人，仍要真人跑一局。');
  process.exit(bad === 0 ? 0 : 1);
}

main();
