/**
 * 真人跑一轮之后，把五个该看的数拉出来（2026-08-28）
 *
 *   npx tsx scripts/observe-run.ts              最近 3 个业务日
 *   npx tsx scripts/observe-run.ts --days 7
 *   npx tsx scripts/observe-run.ts --user AB
 *
 * ★ 为什么需要这个脚本 ★
 * 2026-08-28 的四批改动，改的全是「人怎么练、怎么被判」：抽哪道题、什么算有效局、
 * 复盘要不要答、每天派哪三封、每轮给不给提示。而**全部验证来自测试与脚本跑的机器人数据**——
 * 库里 5 个业务员账号有 4 个 `passwordHash` 为空，从没真人登录过。
 *
 * 换句话说：这五条规则在真人身上会怎样，**目前一个数据点都没有**。
 * 这个脚本就是为了让第一批真人数据一出来就能立刻回答那五个问题，
 * 而不是等到有人抱怨了才回头查。
 *
 * ★ 只读，不写任何东西 ★ 它不改判定、不改留档，随时可以跑。
 */

import { prisma } from '../src/lib/db';
import { businessDay, recentBusinessDays } from '../src/lib/business-day';
import { didRealWork, turnActivity } from '../engine/facts';
import { ADMISSION_CONFIG } from '../src/lib/admission-v11';
import type { SessionFacts } from '../engine/types';

const args = process.argv.slice(2);
const argOf = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DAYS = Number(argOf('days') ?? 3);
const ONLY_USER = argOf('user');

function pct(n: number, total: number): string {
  return total === 0 ? '—' : `${Math.round((n / total) * 100)}%`;
}

function minutes(from: Date, to: Date | null): number | null {
  if (!to) return null;
  const m = (to.getTime() - from.getTime()) / 60000;
  return m >= 0 && m < 600 ? m : null; // 超过 10 小时的多半是开着没关，不算
}

async function main() {
  const days = recentBusinessDays(DAYS, businessDay());
  const since = new Date(`${days[days.length - 1]}T00:00:00+08:00`);

  const sessions = await prisma.session.findMany({
    where: {
      createdAt: { gte: since },
      ...(ONLY_USER ? { user: { code: ONLY_USER } } : {}),
    },
    include: {
      user: { select: { code: true, name: true, passwordHash: true } },
      score: { select: { rawScore: true, precise: true } },
      coachQa: { select: { answer: true, skipped: true } },
      variant: { select: { persona: { select: { code: true } } } },
      _count: { select: { messages: { where: { role: 'trainee' } } } },
    },
    orderBy: { createdAt: 'asc' },
  });

  // ★ 只看真人 ★ 没设过口令的账号是造数脚本用的，混进来会把每一个数都带偏
  const real = sessions.filter((s) => s.user.passwordHash !== null);
  const bots = sessions.length - real.length;

  console.log(`\n════ 真人跑动观测 ｜ 最近 ${DAYS} 个业务日（${days[days.length - 1]} ~ ${days[0]}）════`);
  console.log(`局数：真人 ${real.length} 局${bots > 0 ? `（另有 ${bots} 局来自没设过口令的账号，已排除）` : ''}`);
  if (real.length === 0) {
    console.log('\n还没有真人数据。让 2–3 个人按正常节奏跑三天，再回来跑这个脚本。');
    console.log('（判据是账号设过口令——造数脚本用的账号 passwordHash 为空）\n');
    await prisma.$disconnect();
    return;
  }

  const drills = real.filter((s) => s.mode === 'DRILL');
  const exams = real.filter((s) => s.mode === 'ADMISSION_EXAM');

  /* ───────── ① 有效局判据有没有误伤 ───────── */
  console.log('\n──── ① 有效局第三条「真问出了东西」误伤了几局 ────');
  const chatted = drills.filter(
    (s) => s._count.messages >= ADMISSION_CONFIG.validDrillMinTurns || Boolean(s.exitReason),
  );
  const scored = chatted.filter((s) => s.score !== null);
  const hurt = scored.filter((s) => !didRealWork(s.facts as unknown as SessionFacts));
  console.log(`  聊满 ${ADMISSION_CONFIG.validDrillMinTurns} 轮的演习局 ${chatted.length} 局，其中出了分的 ${scored.length} 局`);
  console.log(`  ★ 出了分却被判「没干活」：${hurt.length} 局（${pct(hurt.length, scored.length)}）`);
  for (const s of hurt.slice(0, 8)) {
    console.log(`      ${s.drillId}　${s.user.code}　${s._count.messages} 轮`);
  }
  console.log(
    hurt.length === 0
      ? '  → 没有误伤。判据松紧合适。'
      : '  → 有误伤就去看那几局的对话：如果人确实认真聊了却被判没干活，判据要放宽（改 didRealWork）。',
  );

  /* ───────── ② 复盘跳过率 ───────── */
  console.log('\n──── ② 复盘五问：出了题之后，人到底答不答 ────');
  const withQa = real.filter((s) => s.coachQa.length > 0);
  const answered = withQa.filter((s) => s.coachQa.some((q) => Boolean(q.answer?.trim())));
  const skipped = withQa.filter((s) => s.coachQa.every((q) => q.skipped || !q.answer?.trim()));
  const fullyAnswered = withQa.filter((s) => s.coachQa.every((q) => Boolean(q.answer?.trim())));
  console.log(`  出过复盘题的局 ${withQa.length} 局`);
  console.log(`    全部答完 ${fullyAnswered.length}（${pct(fullyAnswered.length, withQa.length)}）`);
  console.log(`    答了一部分 ${answered.length - fullyAnswered.length}`);
  console.log(`  ★ 一题没答／整局跳过：${skipped.length}（${pct(skipped.length, withQa.length)}）`);
  console.log(
    '  → 跳过率接近 100% 的话，这一步就该重新设计而不是保留：要么给它一个不涉及准入的回报，要么撤掉。',
  );
  console.log('    （2026-08-28 起复盘不计分、可跳过，所以这个数才有意义——它量的是自愿程度）');

  /* ───────── ③ 间隔重复有没有真的在转 ───────── */
  console.log('\n──── ③ 派单：同一考点隔多久回来 ────');
  const byUserCode = new Map<string, { code: string; day: string }[]>();
  for (const s of drills) {
    const list = byUserCode.get(s.user.code) ?? [];
    list.push({ code: s.variant.persona.code, day: businessDay(s.createdAt) });
    byUserCode.set(s.user.code, list);
  }
  for (const [user, list] of byUserCode) {
    const seen = new Map<string, number>();
    for (const item of list) seen.set(item.code, (seen.get(item.code) ?? 0) + 1);
    const repeated = [...seen.entries()].filter(([, n]) => n > 1);
    console.log(
      `  ${user}：练了 ${list.length} 局 / ${seen.size} 个考点` +
        (repeated.length ? `，其中 ${repeated.length} 个考点回来过（${repeated.map(([c, n]) => `${c}×${n}`).join(' ')}）` : '，还没有考点回来过'),
    );
  }
  console.log('  → 三天之内就该看到第 1 盒（次日）与第 2 盒（3 天）的考点回来。');
  console.log('    一个都没回来 = 间隔重复没起作用；回来得太密 = 盒子推进有问题。');
  console.log('    ★ 同时问一句业务员：卡片上那句「◇ 上次这个考点 54 分」他看不看得懂 ★');

  /* ───────── ④ 日负荷：真实耗时 ───────── */
  console.log('\n──── ④ 日负荷：一局到底要多久（这个数从来没人量过）────');
  const durations = real
    .map((s) => ({ s, m: minutes(s.createdAt, s.endedAt) }))
    .filter((x): x is { s: (typeof real)[number]; m: number } => x.m !== null);
  if (durations.length === 0) {
    console.log('  还没有打完的局，量不出来');
  } else {
    const sorted = durations.map((x) => x.m).sort((a, b) => a - b);
    const mid = sorted[Math.floor(sorted.length / 2)]!;
    console.log(
      `  单局用时：中位 ${mid.toFixed(0)} 分钟 ｜ 最快 ${sorted[0]!.toFixed(0)} ｜ 最慢 ${sorted[sorted.length - 1]!.toFixed(0)}（${durations.length} 局）`,
    );
    // 按人按天汇总
    const perDay = new Map<string, number>();
    for (const { s, m } of durations) {
      const key = `${s.user.code}|${businessDay(s.createdAt)}`;
      perDay.set(key, (perDay.get(key) ?? 0) + m);
    }
    for (const [key, total] of [...perDay].sort()) {
      const [code, day] = key.split('|');
      console.log(`    ${code} ${day}：合计 ${(total / 60).toFixed(1)} 小时`);
    }
  }
  console.log('  → 训练期一天要 3 局演习 + 3 局考试。在岗期每天仍要 3 局考试，而那时他手上已经有真实客户。');
  console.log('    ★ 「日负荷保持不变」是当时定的，但那是在没有这个数的情况下定的 ★ 拿到数再裁一次。');

  /* ───────── ⑤ 轮内提示会不会太吵 ───────── */
  console.log('\n──── ⑤ 轮内提示：一局里会弹多少次 ────');
  const msgs = await prisma.message.findMany({
    where: { sessionId: { in: drills.map((s) => s.id) }, role: 'trainee' },
    select: { sessionId: true, turn: true },
  });
  const turnsBySession = new Map<string, number[]>();
  for (const m of msgs) {
    const list = turnsBySession.get(m.sessionId) ?? [];
    list.push(m.turn);
    turnsBySession.set(m.sessionId, list);
  }
  let quietTurns = 0;
  let doubleQuiet = 0;
  let totalTurns = 0;
  for (const s of drills) {
    const facts = s.facts as unknown as SessionFacts;
    const quiet = (t: number) => {
      const a = turnActivity(facts, t);
      return !a.formAction && a.unlocked === 0 && a.asked === 0 && a.collected === 0;
    };
    for (const turn of turnsBySession.get(s.id) ?? []) {
      totalTurns += 1;
      if (!quiet(turn)) continue;
      quietTurns += 1;
      if (turn > 1 && quiet(turn - 1)) doubleQuiet += 1;
    }
  }
  console.log(`  演习局共 ${totalTurns} 轮`);
  console.log(`    单轮没进展：${quietTurns} 轮（${pct(quietTurns, totalTurns)}）← 这是**第一版**的提示频率`);
  console.log(`  ★ 连着两轮没进展：${doubleQuiet} 轮（${pct(doubleQuiet, totalTurns)}）← 这才是现在的提示频率`);
  console.log('  → 2026-08-28 当天就是拿这两个数把提示从「单轮」改成「连着两轮」的：');
  console.log('    单轮那版实测 52%，一半以上的轮次都在弹，那不是提醒是背景噪音。');
  console.log('    现在这个数如果还超过 25%，说明仍然偏吵，再往上收一档。');

  /* ───────── 附：考试侧 ───────── */
  if (exams.length > 0) {
    const preciseScores = exams
      .map((s) => (s.score?.precise ? s.score.rawScore : null))
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
    console.log(`\n──── 附 · 考试局 ${exams.length} 局 ────`);
    if (preciseScores.length) {
      console.log(
        `  出精确分 ${preciseScores.length} 局：中位 ${preciseScores[Math.floor(preciseScores.length / 2)]} ｜ ` +
          `最低 ${preciseScores[0]} ｜ 最高 ${preciseScores[preciseScores.length - 1]}（准入线 ${ADMISSION_CONFIG.medianScoreMin}）`,
      );
    }
    const codes = exams.map((s) => s.variant.persona.code);
    const dup = new Map<string, number>();
    for (const c of codes) dup.set(c, (dup.get(c) ?? 0) + 1);
    const repeats = [...dup.entries()].filter(([, n]) => n > 1);
    console.log(
      repeats.length
        ? `  ★ 有考点重复出现：${repeats.map(([c, n]) => `${c}×${n}`).join(' ')} —— 这正是抽题改动要压下去的东西，盯住它`
        : '  考点没有重复',
    );
  }

  console.log('\n════ 完 ════\n');
  await prisma.$disconnect();
}

main();
