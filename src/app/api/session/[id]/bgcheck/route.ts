import { NextResponse } from 'next/server';
import { guardAct } from '@/lib/session-guard';
import { prisma } from '@/lib/db';
import { stripAnswers } from '@/lib/bg-package';
import type { SessionFacts } from '../../../../../../engine/types';

/**
 * 背调子系统（需求第 6 章）
 *
 * ★ 为什么必须有 ★
 * v1.0 的人设 3 要考背调意识，但系统里**没有任何可查的东西**——
 * 新人只能凭空说"我怀疑你"，考不出第一课 7.4 那整套交叉验证。
 *
 * ★ 记录三件事 ★（评分挂钩靠它们）
 *   bg_initiated：发起没有
 *   bg_items_viewed[]：查了哪几项（只看 AI 报告不做交叉验证，等于没背调）
 *   bg_error_detected：有没有识破预埋错误
 */

/** 发起背调 / 查看某一项 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { item } = (await req.json().catch(() => ({}))) as { item?: string };

  const g = await guardAct(id);
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const s = await prisma.session.findUnique({
    where: { id },
    include: { variant: { include: { bgPackage: true } } },
  });
  if (!s) return NextResponse.json({ error: '找不到这一局' }, { status: 404 });
  if (!s.variant.bgPackage) {
    return NextResponse.json({ error: '这个人设没有配背调资料包' }, { status: 404 });
  }

  const facts = s.facts as unknown as SessionFacts;
  const viewed = new Set(facts.bgItemsViewed ?? []);
  if (item) viewed.add(item);

  const nextFacts: SessionFacts = {
    ...facts,
    bgInitiated: true,
    bgItemsViewed: [...viewed],
  };

  await prisma.session.update({ where: { id }, data: { facts: nextFacts as unknown as object } });

  const pkg = s.variant.bgPackage;
  // ★ 一律过 stripAnswers ★ 见 lib/bg-package.ts：预埋错误的真相与「从哪能识破」
  // 都躺在这几块 JSON 里，整块返回等于把答案随响应发给考生（前端没渲染 ≠ 没发出去）
  return NextResponse.json({
    aiReport: stripAnswers(pkg.aiReport),
    website: item === 'website' || viewed.has('website') ? stripAnswers(pkg.website) : null,
    social: item === 'social' || viewed.has('social') ? stripAnswers(pkg.social) : null,
    contacts: item === 'contacts' || viewed.has('contacts') ? stripAnswers(pkg.contacts) : null,
    viewed: [...viewed],
  });
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const s = await prisma.session.findUnique({
    where: { id },
    include: { variant: { include: { bgPackage: true } } },
  });
  if (!s?.variant.bgPackage) return NextResponse.json({ available: false });

  const facts = s.facts as unknown as SessionFacts;
  return NextResponse.json({
    available: true,
    initiated: facts.bgInitiated,
    viewed: facts.bgItemsViewed ?? [],
    errorDetected: facts.bgErrorDetected,
  });
}
