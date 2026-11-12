/**
 * 主循环冒烟：一轮到底走一遍真数据库（`npm run smoke:turn`）
 *
 * ```
 * npm run db:up          # 本地 postgres（5433）
 * npm run smoke:turn
 * ```
 *
 * ★ 这是这套系统里第一份覆盖「落库路径」的自动化检查 ★
 * 在它之前，160 条单测全是纯函数（判定引擎、状态机、报告），
 * 而两份规则文档都写着同一句话：**最大的空白是要连库的那一层**——
 * `session-service` / `board` / `settlement` 一条测试都没有，
 * 全靠「改完人工跑一遍取数脚本核对」。这份先把主循环那一段补上。
 *
 * ★ 不需要模型 key，也不许有 ★ `hasApiKey()` 为 false 时抽取走默认值、
 * 客户回一句固定文案，引擎与落库照常跑完——要验的东西一样不少，
 * 而且**完全确定性、可重复、不花钱**。有 key 时脚本直接拒跑：
 * 掺进模型的随机性，这份检查就再也不能当回归用了。
 *
 * ★ 只跑本地库 ★ DATABASE_URL 不是 localhost 就拒跑。它会真的建人、建局、写消息，
 * 虽然跑完就清干净，但那种「跑完就清干净」的脚本正是最容易误指向生产的一类。
 *
 * 它验的是：消息成不成对、轮次连不连续、快照存没存、
 * **并发时会不会写出两条第 N 轮**、幂等、跟进局前情会不会重复或漏、报价那条入口。
 * 它不验模型质量——那要花钱，且不确定，属于另一件事。
 *
 * 出处：2026-08-22 修 N-4（把两次 LLM 调用移出数据库事务）时写的验证脚本，
 * 当场 29 项全过，遂留作回归。改动 `runTurn` 之后请再跑一遍。
 */

import 'dotenv/config';

/**
 * ★ 在加载任何应用模块之前把 key 清掉 ★
 * `llm/client.ts` 是在模块顶层读 `process.env.DEEPSEEK_API_KEY` 的，读完就定死。
 * 所以这一行必须在 import 它之前跑——底下那些应用模块因此全部改成**动态 import**。
 * 这样 `npm run smoke:turn` 在任何 shell 里都能直接跑，不必在命令行前面挂环境变量
 * （PowerShell 不吃 `VAR= cmd` 那一套），也不用为此引一个 cross-env。
 */
process.env.DEEPSEEK_API_KEY = '';

const { prisma } = await import('../src/lib/db');
const { createDrillSession } = await import('../src/lib/create-session');
const { sendMessage, submitQuoteTurn, resolvePendingReply, StaleTurnError } = await import(
  '../src/lib/session-service'
);
const { hasApiKey } = await import('../src/lib/llm/client');

/** 临时账号的简码。用一个真人不可能取的，跑完就删 */
const CODE = 'ZZSMOKE';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  ok(name, Object.is(actual, expected), `实际 ${String(actual)} / 期望 ${String(expected)}`);
}

async function turnOf(sessionId: string): Promise<number> {
  const s = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
  return (s.state as { turn: number }).turn;
}

async function main() {
  if (hasApiKey()) {
    throw new Error('这一遍要在无 API key 下跑（确定性）。请以 DEEPSEEK_API_KEY= 空值启动。');
  }
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('localhost')) {
    throw new Error(`只在本地库跑，当前 DATABASE_URL 不是 localhost：${url.slice(0, 40)}…`);
  }
  console.log('数据库：本地 docker（localhost:5433）｜模型：未配置 key，走确定性分支\n');

  // ── 准备 ──
  await cleanup();
  const user = await prisma.user.create({
    data: { name: 'N4临时验证', code: CODE, role: 'TRAINEE', employeeType: 'OTHER' },
  });

  const inquiry = await prisma.personaVariant.findFirstOrThrow({
    where: { poolType: 'DRILL', active: true, persona: { sessionType: 'INQUIRY' } },
    include: { persona: true },
    orderBy: { variantId: 'asc' },
  });
  const followup = await prisma.personaVariant.findFirst({
    where: { poolType: 'DRILL', active: true, persona: { sessionType: 'FOLLOWUP' } },
    include: { persona: true },
    orderBy: { variantId: 'asc' },
  });
  console.log(`题：探需 ${inquiry.variantId}｜跟进 ${followup?.variantId ?? '（练习池里没有跟进局）'}\n`);

  // ── 一、正常一轮 ──
  console.log('一、正常一轮：消息成对、轮次前进、快照落库');
  const a = await createDrillSession(user, inquiry.variantId);
  const r1 = await sendMessage(a.id, 'Hi, thanks for your inquiry. May I know how many pieces you need?', 'c1', 0);
  eq('返回轮次', r1.turn, 1);
  const msgs1 = await prisma.message.findMany({ where: { sessionId: a.id }, orderBy: [{ turn: 'asc' }, { role: 'desc' }] });
  eq('消息条数（业务员+客户）', msgs1.length, 2);
  ok('两条同属第 1 轮', msgs1.every((m) => m.turn === 1));
  ok('角色成对', msgs1.map((m) => m.role).sort().join(',') === 'customer,trainee');
  ok('两条都存了状态快照', msgs1.every((m) => m.stateSnapshot !== null));
  eq('session.state.turn 已推进', await turnOf(a.id), 1);
  ok('走的是无 key 分支', r1.customerReply.includes('DEEPSEEK_API_KEY'), r1.customerReply.slice(0, 24));

  // ── 二、轮次对不上：整发作废，一个字都不许写 ──
  console.log('\n二、拿旧轮次再发（另一个窗口落后了）');
  let stale = false;
  try {
    await sendMessage(a.id, 'stale window message', 'c-stale', 0);
  } catch (e) {
    stale = e instanceof StaleTurnError;
  }
  ok('抛 StaleTurnError', stale);
  eq('消息条数没变', await prisma.message.count({ where: { sessionId: a.id } }), 2);
  eq('轮次没变', await turnOf(a.id), 1);

  // ── 三、★ 真正要验的：并发 ★ ──
  // 旧实现靠「整轮都在事务里」串行；新实现在事务外算，靠写前复核轮次挡。
  // 两发同时打进来，必须**恰好一发成功**，绝不能写出两条第 2 轮。
  console.log('\n三、并发两发（同一轮次同时提交）');
  const results = await Promise.allSettled([
    sendMessage(a.id, 'concurrent A: what is your target price?', 'cA', 1),
    sendMessage(a.id, 'concurrent B: which port do you ship to?', 'cB', 1),
  ]);
  const okCount = results.filter((r) => r.status === 'fulfilled').length;
  const staleCount = results.filter(
    (r) => r.status === 'rejected' && r.reason instanceof StaleTurnError,
  ).length;
  eq('成功的发数', okCount, 1);
  eq('被判作废的发数', staleCount, 1);
  const msgs2 = await prisma.message.findMany({ where: { sessionId: a.id } });
  eq('消息总数（2 + 2，不是 2 + 4）', msgs2.length, 4);
  eq('第 2 轮的消息条数', msgs2.filter((m) => m.turn === 2).length, 2);
  eq('轮次只前进了一格', await turnOf(a.id), 2);

  // ── 四、幂等 ──
  console.log('\n四、同一个 clientMsgId 重复提交');
  const b = await createDrillSession(user, inquiry.variantId);
  await sendMessage(b.id, 'Could you tell me the quantity?', 'dup-1', 0);
  const before = await prisma.message.count({ where: { sessionId: b.id } });
  const again = await sendMessage(b.id, 'Could you tell me the quantity?', 'dup-1', 0);
  eq('消息没有重复写', await prisma.message.count({ where: { sessionId: b.id } }), before);
  eq('返回的还是那一轮', again.turn, 1);

  // ── 五、跟进局前情：与本轮同事务落地，不重复不遗漏 ──
  if (followup) {
    console.log('\n五、跟进局前情（第 0 轮 system 消息）');
    const c = await createDrillSession(user, followup.variantId);
    eq('开局时一条消息都没有', await prisma.message.count({ where: { sessionId: c.id } }), 0);
    await sendMessage(c.id, 'Hi, just following up on my quotation.', 'f1', 0);
    const cm = await prisma.message.findMany({ where: { sessionId: c.id }, orderBy: [{ turn: 'asc' }, { role: 'desc' }] });
    eq('总数 = 前情 1 + 本轮 2', cm.length, 3);
    eq('第 0 轮的 system 消息只有一条', cm.filter((m) => m.turn === 0 && m.role === 'system').length, 1);
    ok('前情内容非空', Boolean(cm[0]?.content?.trim()));
    await sendMessage(c.id, 'Any update on my request?', 'f2', 1);
    eq('第二轮不会再补一条前情', await prisma.message.count({ where: { sessionId: c.id, turn: 0 } }), 1);
  } else {
    console.log('\n五、跟进局前情 —— 跳过（练习池里没有跟进局变体）');
  }

  // ── 六、报价路径（多产品 + 补充说明窗口）──
  console.log('\n六、报价（走 submitQuoteTurn，另一条入口）');
  const d = await createDrillSession(user, inquiry.variantId);
  const q = await submitQuoteTurn(
    d.id,
    // formatCompliant 不是表单字段，是代码按档位与形式自己判出来的（engine/facts.submitQuote）
    // ★ 两个产品 ★ 2026-08-19 反馈 #6：一轮谈到两个产品，面板要装得下
    {
      lines: [
        { product: 'VC-200', unitPrice: 12.5, quantity: 500 },
        { product: 'VC-300', unitPrice: 8, quantity: 200 },
      ],
      freight: 80,
      tradeTerms: 'FOB Shenzhen',
      leadTimeDays: 35,
      hasQuoteSheet: true,
      hasScreenshot: true,
    },
    'q1',
    0,
  );
  eq('报价也是第 1 轮', q.turn, 1);
  eq('落了 1 条报价', q.facts.quotes.length, 1);
  eq('两个产品都进了事实表', q.facts.quotes[0]?.lines?.length, 2);
  eq('总额按两行合计 + 运费', q.facts.quotes[0]?.total, 12.5 * 500 + 8 * 200 + 80);
  eq('贸易术语落库', q.facts.quotes[0]?.tradeTerms, 'FOB Shenzhen');

  // ★ 补充说明窗口（2026-08-19 反馈 #7）★ 报完价客户先不开口
  const dm = await prisma.message.findMany({ where: { sessionId: d.id } });
  eq('报价这一轮只写业务员一条，客户被按住', dm.length, 1);
  ok('客户确实还没回', !dm.some((m) => m.role === 'customer'));
  ok('等待态已置上', Boolean(q.state.awaitingReply));
  ok('报价原文进了业务员那条', dm.some((m) => m.role === 'trainee' && m.content.includes('Quotation')));
  ok('两个产品都写进了对话流', dm.some((m) => m.content.includes('VC-200') && m.content.includes('VC-300')));

  // 说完了 → 客户这才回话，挂在同一轮上
  const r = await resolvePendingReply(d.id, q.turn);
  eq('放行不推进轮次', r.turn, q.turn);
  ok('等待态已清干净', !r.state.awaitingReply);
  const dm2 = await prisma.message.findMany({ where: { sessionId: d.id } });
  eq('这下这一轮凑齐两条了', dm2.length, 2);
  eq('客户那条挂在报价那一轮', dm2.filter((m) => m.role === 'customer' && m.turn === q.turn).length, 1);

  // ── 七、事务里没有网络调用（回归 N-4 本身）──
  console.log('\n七、代码形态检查');
  const src = await import('node:fs/promises').then((fs) =>
    fs.readFile('src/lib/session-service.ts', 'utf8'),
  );
  /**
   * ★ 逐个事务查，不再"从第一个事务切到文件末尾" ★（2026-08-23 修）
   *
   * 老写法是 `src.slice(src.indexOf('await prisma.$transaction('))`——它默认
   * 全文件只有一个事务、而且它在文件最后。2026-08-19 反馈 #7 加了
   * `resolvePendingReply`（自带一个事务、位置在 `runTurn` 之前）之后，
   * 那一刀就把 `runTurn` 里**事务外**的两次模型调用也切进来了，两条判定当场变红——
   * 代码没问题，是判据错了。判据出假警报比不判还糟：下次真出事没人信它。
   *
   * 现在按 `{ timeout:` 给每个事务体划出右边界，逐个查。
   */
  const txBodies: string[] = [];
  for (let i = src.indexOf('await prisma.$transaction('); i !== -1; i = src.indexOf('await prisma.$transaction(', i + 1)) {
    const end = src.indexOf('{ timeout:', i);
    txBodies.push(src.slice(i, end === -1 ? src.length : end));
  }
  ok('至少查到了两个事务（runTurn 与 resolvePendingReply）', txBodies.length >= 2, `实际 ${txBodies.length} 个`);
  ok('事务里不再调抽取', txBodies.every((b) => !b.includes('await extract(')));
  ok('事务里不再调扮演', txBodies.every((b) => !b.includes('await roleplay(')));
  // 只看代码行，不看注释——注释里写着「原来是 120_000」，那是留给后人看的凭据，不是代码
  const codeOnly = src
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');
  ok(
    '事务超时已从 120 秒降到 15 秒',
    !codeOnly.includes('120_000') && codeOnly.includes('{ timeout: 15_000 }'),
  );

  await cleanup();
  console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

/** 只删这个临时账号自己的东西，别的一律不碰 */
async function cleanup() {
  const u = await prisma.user.findUnique({ where: { code: CODE } });
  if (!u) return;
  const sessions = await prisma.session.findMany({ where: { userId: u.id }, select: { id: true } });
  for (const s of sessions) await prisma.session.delete({ where: { id: s.id } });
  await prisma.user.delete({ where: { id: u.id } });
}

main()
  .catch((e) => {
    console.error('\n跑挂了：', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
