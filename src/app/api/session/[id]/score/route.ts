import { NextResponse } from 'next/server';
import { guardAct } from '@/lib/session-guard';
import { prisma } from '@/lib/db';
import type { SessionFacts, Force } from '../../../../../../engine/types';
import { FORCES } from '../../../../../../engine/types';
import { verifyEvidence, computeSessionScore } from '../../../../../../engine/scoring';
import { scoreSession } from '@/lib/llm/score';
import { buildReport } from '@/lib/report';
import { hasApiKey } from '@/lib/llm/client';
import { refreshAssignedTaskCompletion, V3_SCORE_RULE_VERSION } from '@/lib/training';
import { settleExam } from '@/lib/redline-review';
import { variantDifficulty } from '@/lib/variant-difficulty';

export const maxDuration = 300;

/**
 * 结束本局并评分。
 *
 * ★ 这一层只干一件事：保证不管里面怎么炸，回给前端的永远是 JSON ★
 * 2026-08-14：`scoreSession` 抛异常时 Next 返回的 500 是空 body，
 * 前端 `await r.json()` 于是报「JSON输入意外结束」——一句和病因毫无关系的话，
 * 真正的原因（模型返回的工具参数带尾巴）只在终端里，用的人根本看不见。
 * 出错要让人看见出的是什么错，这是最低要求。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    return await handleScore(req, ctx);
  } catch (e) {
    const msg = (e as Error)?.message ?? '未知错误';
    console.error('[score] 评分失败：', e);
    return NextResponse.json({ error: `评分失败：${msg}` }, { status: 500 });
  }
}

async function handleScore(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const g = await guardAct(id);
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const s = await prisma.session.findUnique({
    where: { id },
    include: {
      variant: { include: { persona: true } },
      messages: { orderBy: [{ turn: 'asc' }, { role: 'desc' }] },
      coachQa: { orderBy: { idx: 'asc' } },
      score: true,
    },
  });
  if (!s) return NextResponse.json({ error: '找不到这一局' }, { status: 404 });
  if (s.score) return NextResponse.json({ ok: true, alreadyScored: true });
  if (!hasApiKey()) return NextResponse.json({ error: '未配置 DEEPSEEK_API_KEY' }, { status: 500 });

  /**
   * ★ 这里原来是「复盘五答未齐就不许评分」的 409 硬闸。2026-08-28 拆掉 ★
   *
   * 王老师 2026-08-19 已经裁定复盘作答质量「撇出去，不作为评分标准」，代码那边照做了
   *（`ADMISSION_CONFIG.activeGates` 只剩 score，`computeSessionScore` 不读 answerQuality）。
   * 于是这道闸拦出来的是一件很别扭的事：**必须做、但做不做不改变任何结果**。
   * 一个零回报的强制环节，最后一定被敷衍成五个「没想法」——那比不问更糟，
   * 因为它还占着评分链路上的一道 409。2026-08-28 裁定：挪出阻塞路径，改成可选。
   *
   * ★ 复盘本身一个字没删 ★ 题照出、追问照追、报告照读复盘答案、
   * `answerQuality` 照落库（管理者要看完成率，数据是全的）。变的只是「不答也能出分」。
   *
   * ★ 挪走它会连带拆掉另一道闸，所以同批补上了 ★
   * 「有效演习局」原来靠「出了分 ⇒ 过了这道 409 ⇒ 复盘真做了」推第三条。
   * 链断了之后闸门会退回成「聊 6 轮 + 点评分」，也就是 N-6 修掉的「三次敷衍」。
   * 第三条现在换成 `engine/facts.didRealWork()`：本局至少解锁 1 张暗牌、
   * 或至少开口问过 1 项六要素。**别把这道 409 加回来而不去看那边。**
   */

  const facts = s.facts as unknown as SessionFacts;
  const messages = s.messages.map((m) => ({ turn: m.turn, role: m.role, content: m.content }));
  const variant = s.variant as unknown as { hiddenCard: Record<string, { value: string; unlock: string }> };

  // ★ 七力口径从人设读 ★（2026-08-14）
  // 原来这两行是写死的 `['insight','guidance','solution','trust','closing']`，
  // 旁边留着一句「后续人设从配置里读」——这件事一直没做。
  // 于是**每一局都按 P1 的口径评分**：P7 极限压价型的谈判力不评、
  // P19 首响过慢型的稳定力不评，而那恰恰是这两个骨架的主考点。
  // 人设 JSON 里那个 active_forces 字段，在这之前是纯装饰。
  const activeForces = toForces(s.variant.persona.activeForces);
  const naForces = toForces(s.variant.persona.naForces);

  // ★ 读不到就拒评，不顶默认值 ★
  // 顶一套默认值最省事，但那样这一局是按什么口径判的、判得对不对，事后谁也说不清。
  // 题型行由题库装入器按考纲写，七力一定是齐的；走到这里说明库被绕过装入器改过。
  if (activeForces.length === 0) {
    return NextResponse.json(
      {
        error:
          `题型 ${s.variant.persona.code} 在库里没有七力配置，这一局没法评分。` +
          `请重新装入题库包（npm run bank -- load），题型的七力会按考纲写进库。`,
      },
      { status: 409 },
    );
  }

  const llm = await scoreSession({
    sessionId: s.id,
    sessionType: s.type === 'FOLLOWUP' ? 'followup' : 'inquiry',
    facts,
    messages,
    hiddenCards: variant.hiddenCard,
    activeForces,
    naForces,
    coachQa: s.coachQa.map((q) => ({ question: q.question, answer: q.answer })),
  });

  // ★ 引文校验 —— 评分可信度的地基 ★
  // 只拿业务员自己说过的话当证据；引不出原话的维度降为 INSUFFICIENT
  const traineeMsgs = messages.filter((m) => m.role === 'trainee');
  const verified = verifyEvidence(llm.forces, traineeMsgs);

  // ★ 没做复盘问答就不许有作答质量 ★
  // 模型会自作主张填 0，那会误触发「高分·零认知」红旗——
  // 「答不上来」和「压根没问过他」是两回事，混为一谈等于凭空给人扣一顶帽子。
  //
  // ★ 判据是「有没有真的答」，不是「有没有出过题」★（2026-08-22 修）
  // 原来写的是 `s.coachQa.length > 0`——整局跳过之后题目还在，`length` 照样 > 0，
  // 于是模型对着五个 null 打分（多半给 0），**红旗照扣**。
  // 那正是上面这段注释要防的事，判据自己却把它放了进来。
  const answered = s.coachQa.some((q) => Boolean(q.answer?.trim()));
  const answerQuality = answered ? llm.answer_quality : undefined;

  const score = computeSessionScore({
    scores: verified,
    sessionType: s.type === 'FOLLOWUP' ? 'followup' : 'inquiry',
    progress: llm.progress,
    answerQuality,
    /**
     * ★ 难度系数用的是这一局【开局那一刻】的快照，不是"现在的设置" ★
     * 主管今天改了系数，昨天开的局必须按昨天那个系数出分——
     * 否则同一场考试的三局会落到两套口径上，而它们要一起算中位数。
     */
    difficultyFactor: s.difficultyFactor,
  });

  const reportMd = buildReport({
    drillId: s.drillId,
    turn: (s.state as unknown as { turn: number }).turn,
    difficulty: variantDifficulty(s.variant),
    followup: s.type === 'FOLLOWUP',
    exitReason: s.exitReason,
    facts,
    llm: { ...llm, answer_quality: answerQuality },
    score,
    verified,
    coachQa: s.coachQa.map((q) => ({ question: q.question, answer: q.answer })),
  });

  await prisma.score.create({
    data: {
      sessionId: s.id,
      forces: verified as unknown as object,
      coverage: score.coverage,
      evaluableCount: score.evaluableCount,
      precise: score.precise,
      rawScore: score.rawScore ?? null,
      // 折算之前的分。和 Session.difficultyFactor 一起，才答得出「70 分为什么显示 65」
      baselineScore: score.baselineScore ?? null,
      tier: score.tier ?? null,
      progress: llm.progress,
      answerQuality: answerQuality ?? null,
      flags: score.flags as unknown as object,
      // 考试局（准入 / 周考）必须锁定同一 v3 评分版本；普通演习继续沿用 v2 口径。
      scoreRuleVersion:
        s.mode === 'ADMISSION_EXAM'
          ? V3_SCORE_RULE_VERSION
          : 'v2_forces_from_persona',
      reportMd,
    },
  });

  await prisma.session.update({
    where: { id: s.id },
    data: { status: 'ENDED', endedAt: s.endedAt ?? new Date(), exitReason: s.exitReason ?? 'manual_end' },
  });

  try {
    await refreshAssignedTaskCompletion(s.id);
  } catch (error) {
    // 分数与报告已经落库，任务编排失败不能把前端伪装成“评分失败”。
    // 保留错误日志，任务页下次加载时可重试修复。
    console.error('[score] 评分已完成，但 v3 任务状态刷新失败：', error);
  }

  // ★ 三局都出分就自动交卷 ★（v1.1）
  // 过去交卷要考生自己点「结算本组」——等于让被判的人决定什么时候被判。
  // 一个自觉考砸的人只要不点，那场考试就永远悬着。现在评完最后一局立刻结算，
  // 就算这里失败了也不影响判定：每晚结算读的是局和分，不读考试的结算状态。
  if (s.mode === 'ADMISSION_EXAM') {
    try {
      const attempt = await prisma.examAttempt.findFirst({
        where: { userId: s.userId, sessionIds: { has: s.id }, verdict: null },
      });
      if (attempt) {
        const unscored = await prisma.session.count({
          where: { id: { in: attempt.sessionIds }, score: { is: null } },
        });
        if (unscored === 0) await settleExam(attempt.id);
      }
    } catch (error) {
      console.error('[score] 分已落库，但自动交卷失败（不影响每晚结算）：', error);
    }
  }

  return NextResponse.json({
    ok: true,
    precise: score.precise,
    tier: score.tier,
    rawScore: score.rawScore,
    evidenceDowngraded: countDowngraded(llm.forces, verified),
  });
}

/**
 * 把库里存的 Json 转成 Force[]，越界的一律丢掉。
 * 数据库里是 Json 列，类型系统管不住它；这里不校验，一个拼错的力名就会一路飘到评分提示词里。
 */
function toForces(raw: unknown): Force[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((f): f is Force => typeof f === 'string' && (FORCES as readonly string[]).includes(f));
}

/** 有多少个维度因为引文对不上被降为证据不足——这个数非零说明模型在编引文 */
function countDowngraded(before: typeof verifyEvidence extends never ? never : Parameters<typeof verifyEvidence>[0], after: ReturnType<typeof verifyEvidence>): number {
  let n = 0;
  for (const k of Object.keys(after) as (keyof typeof after)[]) {
    const b = before[k];
    const a = after[k];
    if (b && a && typeof b.score === 'number' && a.score === 'INSUFFICIENT') n += 1;
  }
  return n;
}
