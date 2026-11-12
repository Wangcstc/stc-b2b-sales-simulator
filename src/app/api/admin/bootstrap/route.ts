import { NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BankLoadError, loadBank } from '@/lib/bank-loader';
import { prisma } from '@/lib/db';
import { runSeed } from '@/lib/seed-core';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * 一次性初始化接口：建表 + 基础数据 + （可选）装入题库包。
 *
 * ★ 为什么要有这个东西 ★
 * 开发机未必连得上云数据库（有些网络会拦 5432 端口，本地 `prisma migrate deploy`
 * 与 `npm run seed` 会报 P1001），而部署好的服务端和数据库之间一般是通的——
 * 所以把这几步搬到服务端接口里做，绕开开发机的网络。
 *
 * ★ 三条安全约束 ★
 * ① 必须带 token，且 token 只从环境变量读——**没配 BOOTSTRAP_TOKEN 就一律拒绝**，
 *    绝不给默认值：有默认值等于这个接口对全网敞开。
 * ② 全程幂等：表已存在就不建；基础数据全是 upsert；同一题库版本装两次会自动跳过。
 * ③ **不删任何东西**——没有 DROP，没有 TRUNCATE。业务员的局和评分动不了。
 *
 * ★ 题库从哪来 ★ 环境变量 `BANK_DIR` 指向部署包里的一个题库包目录（相对项目根目录）。
 * 没配就只建表和主管账号，柜子以空题库启动，主管登录后会看到首次引导。
 *
 * ★ 升级已有的库不走这里 ★ 表已存在时只跳过建表；数据库结构升级请用 `prisma migrate deploy`。
 */

/** 探一张表在不在。用它判断要不要建表，比 catch「already exists」干净 */
async function tablesExist(): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ reg: string | null }[]>(
    `SELECT to_regclass('public."PersonaVariant"')::text AS reg`,
  );
  return Boolean(rows[0]?.reg);
}

function sqlStatements(relativePath: string): string[] {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function POST(req: Request) {
  const expected = process.env.BOOTSTRAP_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: '未配置 BOOTSTRAP_TOKEN，该接口已禁用' }, { status: 503 });
  }
  if (req.headers.get('x-bootstrap-token') !== expected) {
    return NextResponse.json({ error: '令牌不对' }, { status: 401 });
  }

  const log: string[] = [];

  try {
    // ── 建表 ──
    if (await tablesExist()) {
      log.push('· 数据表已存在，跳过建表（结构升级请用 prisma migrate deploy）');
    } else {
      const statements = sqlStatements('prisma/init.sql');
      for (const s of statements) await prisma.$executeRawUnsafe(s);
      log.push(`✓ 建表完成，执行 ${statements.length} 条语句`);
    }

    // ── 基础数据 ──
    log.push(...(await runSeed(prisma)));

    // ── 题库包 ──
    const bankDir = process.env.BANK_DIR;
    if (bankDir) {
      const r = await loadBank(prisma, resolve(process.cwd(), bankDir));
      log.push(
        r.status === 'already-loaded'
          ? `· 题库 ${r.bankId} v${r.bankVersion} 已装入过，跳过`
          : `✓ 已装入题库 ${r.bankId} v${r.bankVersion}：${r.questions} 道题`,
      );
    } else {
      log.push('· 未配置 BANK_DIR，题库为空。主管登录后按首次引导装入题库');
    }

    const counts = {
      题型: await prisma.persona.count({ where: { variants: { some: { active: true } } } }),
      演习池: await prisma.personaVariant.count({ where: { poolType: 'DRILL', active: true } }),
      考试池: await prisma.personaVariant.count({ where: { poolType: 'ADMISSION_EXAM', active: true } }),
      账号: await prisma.user.count(),
    };

    return NextResponse.json({ ok: true, counts, log });
  } catch (e) {
    // 把已经跑完的部分也带回来——失败在第几步一眼可见
    const findings = e instanceof BankLoadError ? e.findings.slice(0, 40) : undefined;
    return NextResponse.json({ ok: false, error: (e as Error).message, findings, log }, { status: 500 });
  }
}
