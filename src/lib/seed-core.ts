/**
 * 基础数据（v8.2 起）：主管账号与身份对齐。**脚本与云端接口共用这一份。**
 *
 * ★ 这里不再灌任何题 ★ 题目一律通过题库包装入（`src/lib/bank-loader.ts`），
 * 柜子代码里不出现任何具体题目。题库为空时柜子照常能启动，主管会看到首次引导。
 *
 * ★ 为什么不放在 scripts/seed.ts 里 ★ 开发机未必连得上云数据库（有些网络会拦 5432 端口），
 * 所以云端部署时由 /api/admin/bootstrap 接口在服务端执行；两条路径必须共用一套逻辑。
 *
 * 全程 upsert，**可以反复跑**，不会产生重复数据。
 */
import type { PrismaClient } from '@prisma/client';

/** 建主管账号并对齐主管身份。返回逐条日志，调用方自己决定是打印还是当 JSON 返回 */
export async function runSeed(prisma: PrismaClient): Promise<string[]> {
  const log: string[] = [];

  // 种一个主管账号做起点，业务员由主管在「账号管理」里添加。
  // 简码 ADMIN，姓名用中性的「管理员」——不占任何人的名字，也不会和业务员重名。
  //
  // ★ 口令不在这里种 ★ 往代码里写死一个初始口令，等于把它提交进仓库。
  // 新库走「谁先登谁定口令」，要重置找主管在「账号管理」里清。
  await prisma.user.upsert({
    where: { code: 'ADMIN' },
    update: { name: '管理员', role: 'MANAGER' },
    create: { name: '管理员', code: 'ADMIN', role: 'MANAGER' },
  });
  log.push('✓ 主管账号 管理员（简码 ADMIN）');

  /**
   * ★ 主管账号的身份一律对齐成「管理员」★（2026-08-23）
   *
   * 这一段是为了堵住一个坑：主管账号的 employeeType 被手选成了 REGULAR
   * （正式业务员），而它的 participationMode 是 NONE——两个字段对不上，
   * `check-readiness` 一直报「1 个正式业务员账号的参与模式或询盘权限口径错误」，
   * 同时它的 identityConfirmedAt 从没被写过，于是又报「1 个在用账号未确认身份」。
   * 两条告警其实是同一个账号、同一个原因。
   *
   * ★ 为什么放在 seed 里而不是写一条一次性 SQL ★ 一次性 SQL 只修这一次；
   * 放在这里，任何时候重灌库、换环境、加新主管，身份都会自动对齐，不会再错第二次。
   * 界面那边同步做了两件事：主管的身份栏改成只读、设为主管时自动带上管理员身份。
   *
   * 只改身份三件套，**不碰 role、不碰姓名、不碰历史**。
   */
  const misalignedManagers = await prisma.user.findMany({
    where: { role: { not: 'TRAINEE' }, employeeType: { not: 'MANAGER' } },
    select: { id: true, name: true, code: true, employeeType: true },
  });
  for (const manager of misalignedManagers) {
    await prisma.user.update({
      where: { id: manager.id },
      data: {
        employeeType: 'MANAGER',
        participationMode: 'NONE',
        inquiryAccessStatus: 'NOT_APPLICABLE',
        identityConfirmedAt: new Date(),
        trainingStartDay: null,
      },
    });
    log.push(`✓ 主管 ${manager.name}（${manager.code}）身份对齐：${manager.employeeType} → MANAGER（不参加准入，也不参加周考）`);
  }

  return log;
}
