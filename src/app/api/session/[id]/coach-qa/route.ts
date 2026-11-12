import { NextResponse } from 'next/server';
import { guardAct, guardView } from '@/lib/session-guard';
import { prisma } from '@/lib/db';
import type { SessionFacts } from '../../../../../../engine/types';
import { generateQuestions, checkVague } from '@/lib/llm/coach-qa';
import { hasApiKey } from '@/lib/llm/client';

export const maxDuration = 300;

/** 生成 5 个复盘问题（3 针对性 + 2 固定）。已生成过就直接返回 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const g = await guardAct(id);
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const s = await prisma.session.findUnique({
    where: { id },
    include: { messages: { orderBy: [{ turn: 'asc' }, { role: 'desc' }] }, coachQa: { orderBy: { idx: 'asc' } } },
  });
  if (!s) return NextResponse.json({ error: '找不到这一局' }, { status: 404 });
  if (s.coachQa.length > 0) return NextResponse.json({ questions: s.coachQa });
  if (!hasApiKey()) return NextResponse.json({ error: '未配置 DEEPSEEK_API_KEY' }, { status: 500 });
  if (s.messages.length === 0) return NextResponse.json({ error: '这一局还没聊过，没什么可复盘的' }, { status: 400 });

  const questions = await generateQuestions({
    sessionId: s.id,
    facts: s.facts as unknown as SessionFacts,
    messages: s.messages.map((m) => ({ turn: m.turn, role: m.role, content: m.content })),
  });

  await prisma.coachQa.createMany({
    data: questions.map((question, idx) => ({ sessionId: s.id, idx, question })),
  });

  // 局也顺势收尾（手动结束的情形）
  if (s.status === 'ACTIVE') {
    await prisma.session.update({
      where: { id: s.id },
      data: { status: 'ENDED', endedAt: new Date(), exitReason: s.exitReason ?? 'manual_end' },
    });
  }

  const rows = await prisma.coachQa.findMany({ where: { sessionId: s.id }, orderBy: { idx: 'asc' } });
  return NextResponse.json({ questions: rows });
}

/**
 * 提交一题的答案。答得含糊则返回一句追问——**只追问一次，不递归**
 *
 * ★ 这里过去一句鉴权都没有（2026-08-22 修）★
 * 同文件的 POST 有 `guardAct`，PUT 与 GET 一个都没有——**连登录都不需要**，
 * 拿到一个 sessionId 就能给别人的局写答案、或者整局跳过。
 * 后果有三层：污染别人的作答质量与报告；把「拿到 5 个答案前不出诊断」这道硬闸
 * 从旁边绕过去；GET 还能读到任意一局的复盘原文。
 * sessionId 是 cuid 不好枚举，所以一直没出事——**那是没人试过，不是拦住了**。
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  // 作答是「做」不是「看」：主管也不能替人答——替人答出来的复盘质量是假的
  const g = await guardAct(id);
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const body = (await req.json()) as { idx: number; answer?: string; isFollowUp?: boolean; skip?: boolean };

  const row = await prisma.coachQa.findUnique({ where: { sessionId_idx: { sessionId: id, idx: body.idx } } });
  if (!row) return NextResponse.json({ error: '找不到这道题' }, { status: 404 });

  if (body.skip) {
    /**
     * ★ 2026-08-28：考试局也可以跳过了 ★（王老师裁定：复盘挪出阻塞路径，改成可选）
     *
     * 这里原来拦着考试局（2026-08-22 补的闸，理由是「拿到 5 个答案前不做诊断」是灵魂机制）。
     * 那道闸配的是「复盘参与评分」的世界；08-19 裁定复盘作答质量撇出评分之后，
     * 它拦出来的是**必须做、但做不做不改变任何结果**——零回报的强制环节只会被敷衍。
     *
     * ★ 松的只是「能不能跳过」，鉴权一个字没松 ★ 上面的 `guardAct` 照旧：
     * 作答是「做」，主管也不能替人答。**这条千万别一起改回去**——
     * 08-22 那次修的其实是两件事（无鉴权 + 无 mode 判断），只有后一件在今天失效了。
     *
     * 跳过照常留痕：报告会标「因未作答，以下判断为系统推断」，
     * `answerQuality` 不产出（判据是「有没有真的答」，见 score/route.ts）。
     */
    await prisma.coachQa.updateMany({
      where: { sessionId: id, answer: null },
      data: { skipped: true },
    });
    return NextResponse.json({ ok: true, skippedAll: true });
  }

  const answer = (body.answer ?? '').trim();
  if (!answer) return NextResponse.json({ error: '答案不能为空' }, { status: 400 });

  // 回答追问：存进 followUpAnswer，本题到此为止，不再追
  if (body.isFollowUp) {
    await prisma.coachQa.update({
      where: { sessionId_idx: { sessionId: id, idx: body.idx } },
      data: { followUpAnswer: answer },
    });
    return NextResponse.json({ ok: true, followUp: null });
  }

  await prisma.coachQa.update({
    where: { sessionId_idx: { sessionId: id, idx: body.idx } },
    data: { answer },
  });

  // 已经追问过就不再追（不递归）
  if (row.followUp) return NextResponse.json({ ok: true, followUp: null });

  /**
   * ★ 追问要看得见这一局 ★（2026-08-24，08-19 反馈 #9 第三条）
   * 「追问只会根据我们的回答、太死板」说的就是这里：出题时喂了完整对话，
   * 追问却只拿到问题和答案两句。多一次读库换一句能落地的追问，这笔账划得来。
   *
   * 只取业务员和客户的正文，system 那条跟进局前情不进——它不是这一局发生的事。
   */
  const messages = await prisma.message.findMany({
    where: { sessionId: id, role: { in: ['trainee', 'customer'] } },
    orderBy: [{ turn: 'asc' }, { role: 'desc' }],
    select: { turn: true, role: true, content: true },
  });
  const transcript = messages
    .map((m) => `第${m.turn}轮 ${m.role === 'trainee' ? '业务员' : '客户'}：${m.content}`)
    .join('\n');

  const v = await checkVague(id, row.question, answer, transcript);
  if (!v.isVague) return NextResponse.json({ ok: true, followUp: null });

  await prisma.coachQa.update({
    where: { sessionId_idx: { sessionId: id, idx: body.idx } },
    data: { followUp: v.followUp },
  });
  return NextResponse.json({ ok: true, followUp: v.followUp });
}

/** 读这一局的复盘问答。看是「看」：本人或主管（主管盘人要看得到答案原文） */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const g = await guardView(id);
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const rows = await prisma.coachQa.findMany({ where: { sessionId: id }, orderBy: { idx: 'asc' } });
  return NextResponse.json({ questions: rows });
}
