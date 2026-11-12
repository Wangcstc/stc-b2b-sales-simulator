import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUser, canSeeEveryone } from '@/lib/current-user';

/**
 * 提交一局的标尺校准。
 *
 * 写两张表，各司其职：
 *   ScoreCalibration —— 对照数据，Gate 的两个硬数字（差异 ≤1 比例、段位一致率）从这里算；
 *   Calibration      —— 判例，注入评分 prompt，优先级高于所有通用锚点。
 *
 * ★ 只有归因＝锚点问题的才生成判例 ★
 * 取证问题（系统引的原话对不上记录）要修的是引文校验。把它也写成判例，
 * 等于拿一条错误读数去掰弯一把本来准的尺子——会越校越偏。
 */

interface ForceIn {
  key: string;
  label: string;
  system: string;
  human: string;
  cause: string | null;
  shouldBe: string | null;
  anchor: string;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // 校准是定标尺的动作，只有主管能做——业务员给自己判分，标尺就没有意义了
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
  if (!canSeeEveryone(user)) return NextResponse.json({ error: '只有主管能校准标尺' }, { status: 403 });

  const s = await prisma.session.findUnique({ where: { id }, include: { score: true } });
  if (!s) return NextResponse.json({ error: '局不存在' }, { status: 404 });
  if (!s.score) return NextResponse.json({ error: '这一局还没出分，无从校准' }, { status: 400 });

  const body = (await req.json()) as { humanTier: string | null; note: string | null; forces: ForceIn[] };
  if (!Array.isArray(body.forces) || body.forces.length === 0) {
    return NextResponse.json({ error: '至少填一项才能提交' }, { status: 400 });
  }

  const forcesJson = Object.fromEntries(
    body.forces.map((f) => [f.key, { system: f.system, human: f.human, cause: f.cause }]),
  );

  await prisma.scoreCalibration.upsert({
    where: { sessionId: id },
    update: { systemTier: s.score.tier, humanTier: body.humanTier, forces: forcesJson, note: body.note },
    create: {
      sessionId: id,
      systemTier: s.score.tier,
      humanTier: body.humanTier,
      forces: forcesJson,
      note: body.note,
    },
  });

  // 判例：只收锚点问题，且必须写了「应该怎么判」——空判例喂给模型没有信息量
  const cases = body.forces.filter((f) => f.cause === 'anchor' && f.shouldBe && f.shouldBe.trim() !== '');
  for (const f of cases) {
    await prisma.calibration.create({
      data: {
        scenario: `【${f.label}】${s.drillId}：系统命中锚点「${f.anchor || '未记录'}」判 ${f.system} 分`,
        shouldBe: `应判 ${f.human} 分。${f.shouldBe!.trim()}`,
        reason: `王老师 ${new Date().toISOString().slice(0, 10)} 在 ${s.drillId} 上的校准`,
      },
    });
  }

  return NextResponse.json({ ok: true, cases: cases.length });
}
