import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { DEFAULT_RULES } from '../../../../engine/rules';
import type { RuleTable, Extraction, CustomerExtraction, SessionFacts } from '../../../../engine/types';
import { diffRules } from '@/lib/replay';
import { getCurrentUser, canSeeEveryone } from '@/lib/current-user';

/**
 * 回放（技术方案 12.2 / 步骤 47）
 *
 * ★ 这是调参的唯一可行手段 ★
 * 改一个扣分数值 → 对历史所有局重放 → 看有多少局结局变了。
 * 没有它，每调一个数值都要真人聊一局——成本高到根本不会去调，
 * 参数就永远停在第一次拍脑袋的值上。
 *
 * ★ 只给主管 ★（2026-08-06 补）
 * 两条理由，任何一条都够：
 *   1. 它把扣分规则原样摆出来——「回复完没抛问题 −10」给被打分的人看见，
 *      他学的就不是引导，是每句硬塞个问号。等于把答案发给考生。
 *   2. 它回放的是全库的局，返回里带着每一局的演习 ID、结局、红线。
 *      业务员点一下就看到全公司的成绩。
 */
async function requireManager() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!canSeeEveryone(user)) return NextResponse.json({ error: '这是主管的工具' }, { status: 403 });
  return null;
}

export async function POST(req: Request) {
  const denied = await requireManager();
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as {
    overrides?: Record<string, Record<string, number>>;
  };

  // 只允许覆盖已有规则的数值，不允许凭空造规则
  const newRules: RuleTable = JSON.parse(JSON.stringify(DEFAULT_RULES)) as RuleTable;
  for (const [key, patch] of Object.entries(body.overrides ?? {})) {
    if (!(key in newRules)) continue;
    Object.assign((newRules as unknown as Record<string, Record<string, number>>)[key]!, patch);
  }

  const sessions = await prisma.session.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      variant: { include: { persona: true } },
      // ★ 客户消息也要捞 ★ 六要素三态化之后，「收集到」只能由客户那一条促成，
      // 只读 trainee 的话所有要素都停在「问了没答」，红线①会凭空多触发。
      messages: { where: { role: { in: ['trainee', 'customer'] } }, orderBy: { turn: 'asc' } },
    },
  });

  const diffs = sessions
    .filter((s) => s.messages.length > 0)
    .map((s) => {
      const facts = s.facts as unknown as SessionFacts;
      const init = s.variant.initState as { interest?: number };
      return diffRules(
        s.drillId,
        {
          extractions: s.messages
            .filter((m) => m.role === 'trainee' && m.extraction)
            .map((m) => ({ turn: m.turn, extraction: m.extraction as unknown as Extraction })),
          customerAnswers: s.messages
            .filter((m) => m.role === 'customer' && m.extraction)
            .map((m) => ({ turn: m.turn, extraction: m.extraction as unknown as CustomerExtraction })),
          sessionType: s.type === 'FOLLOWUP' ? 'followup' : 'inquiry',
          initialInterest: init.interest ?? 70,
          quotes: facts.quotes ?? [],
          preset: (s.variant.presetElements ?? []) as string[],
        },
        DEFAULT_RULES,
        newRules,
      );
    });

  const changed = diffs.filter((d) => d.changed);
  return NextResponse.json({
    total: diffs.length,
    changedCount: changed.length,
    changedRatio: diffs.length ? Math.round((changed.length / diffs.length) * 100) : 0,
    diffs,
  });
}

export async function GET() {
  const denied = await requireManager();
  if (denied) return denied;
  return NextResponse.json({ rules: DEFAULT_RULES });
}
