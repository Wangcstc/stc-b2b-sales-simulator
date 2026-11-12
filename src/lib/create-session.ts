import { prisma } from './db';
import { initialState } from '../../engine/state-machine';
import { emptyFacts } from '../../engine/facts';
import { emptyUnlockState } from '../../engine/unlock';
import { businessDay } from './business-day';
import { currentDifficultyFactor } from './difficulty-setting';

/**
 * 开一局。演习 ID 前缀强制 D-（需求 12.2）：D-简码-人设-日期-序号
 *
 * ★ 序号必须在锁里算 ★
 * 序号是 count(这个人的局)+1，而 drillId 有唯一约束。新人双击「接待这个客户」
 * 会同时发两个请求，两边都数到同一个数 → 第二个撞唯一键报 500。
 * 2026-08-06 并发实测复现过：同一人两个并发开局请求，一个 200 一个 500。
 *
 * 所以把「数序号 + 建局」放进一个事务，先 SELECT ... FOR UPDATE 锁住这个人的
 * User 行——同一个人的开局请求排队走，不同人各锁各的行，互不影响。
 */
export async function createDrillSession(
  user: { id: string; code: string },
  variantId?: string,
) {
  const variant = variantId
    ? // 题目编号在不同题库版本里会重复，只认当前版本里启用的那一道
      await prisma.personaVariant.findFirstOrThrow({ where: { variantId, active: true }, include: { persona: true } })
    : await prisma.personaVariant.findFirstOrThrow({
        where: { poolType: 'DRILL', active: true },
        include: { persona: true },
      });

  /**
   * ★ 考试专用变体不许当练手局开 ★
   * 首页早就按 examOnly: false 过滤了，所以界面上给不出这个链接——
   * 但开局走的是 `/api/start?variantId=xxx`，变体 ID 是明文的、就印在首页每一行的链接里，
   * 照着改一个 -EX- 就能把考题当练习局刷一遍。考试池与演习池的物理分离（需求 5.3）
   * 只在列表层做等于没做，这一层才是真正的闸。
   */
  if (!variant.active || variant.poolType !== 'DRILL') {
    throw new Error(`${variant.variantId} 是考试专用变体，不能当练手局开——考试请走「考试闸门」`);
  }

  const init = variant.initState as { interest?: number };
  const today = businessDay().replace(/-/g, '');

  // 系数在事务外读：它是一次独立查询，没必要占着行锁
  const difficultyFactor = await currentDifficultyFactor();

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;

    const seq = (await tx.session.count({ where: { userId: user.id } })) + 1;

    return tx.session.create({
      data: {
        drillId: `D-${user.code}-${variant.variantId}-${today}-${String(seq).padStart(2, '0')}`,
        userId: user.id,
        variantId: variant.id,
        // 局型跟着人设走：跟进局的权重与可评维度都不一样（需求第 4 章）
        type: variant.persona.sessionType,
        state: initialState(init.interest ?? 70) as unknown as object,
        // 前情已定的六要素开局即标已知——跟进局里它们本来就写在题面上
        facts: emptyFacts((variant.presetElements ?? []) as string[]) as unknown as object,
        unlockState: emptyUnlockState() as unknown as object,
        // ★ 开局就把难度系数钉在局上 ★ 跑局时读的是这一份快照，不是"当前设置"——
        // 主管中途改系数不许影响正在跑的局，判定也要知道每一局按哪个系数打的。
        difficultyFactor,
      },
    });
  });
}
