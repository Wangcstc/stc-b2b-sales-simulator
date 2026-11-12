/**
 * 题库包命令行。与题库工坊页面调用的是同一组函数（`src/lib/bank-loader.ts`）。
 *
 *   npm run bank -- load <题库包目录> [--no-activate]   校验并装入；默认装完即切为当前版本
 *   npm run bank -- activate <题库编号> <版本号>          切换当前版本（也用于回滚）
 *   npm run bank -- list                                  列出已装入的版本
 *   npm run bank -- validate <题库包目录>                 只校验，不装入
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { resolve } from 'node:path';
import { validateBank } from '../bank-kit/index';
import { activateBankVersion, BankLoadError, listBankVersions, loadBank } from '../src/lib/bank-loader.js';

const [cmd, ...args] = process.argv.slice(2);
const prisma = new PrismaClient();

async function main(): Promise<number> {
  if (cmd === 'validate') {
    const r = validateBank(resolve(args[0] ?? '.'));
    for (const e of r.errors) console.log(`✗ ${e.where}：${e.message}`);
    console.log(r.ok ? '✓ 题库包校验通过' : `✗ 校验不通过：${r.errors.length} 处`);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'load') {
    const dir = args.find((a) => !a.startsWith('--'));
    if (!dir) return usage();
    const r = await loadBank(prisma, resolve(dir), { activate: !args.includes('--no-activate') });
    console.log(
      r.status === 'already-loaded'
        ? `· ${r.bankId} v${r.bankVersion} 之前已装入过（内容相同），${r.activated ? '现为当前版本' : '未切换'}`
        : `✓ 已装入 ${r.bankId} v${r.bankVersion}：${r.questions} 道题，${r.activated ? '已切换为当前版本' : '未切换（--no-activate）'}`,
    );
    return 0;
  }
  if (cmd === 'activate') {
    const [bankId, bankVersion] = args;
    if (!bankId || !bankVersion) return usage();
    const bv = await prisma.bankVersion.findUnique({ where: { bankId_bankVersion: { bankId, bankVersion } } });
    if (!bv) {
      console.log(`✗ 没有装入过 ${bankId} v${bankVersion}`);
      return 1;
    }
    await activateBankVersion(prisma, bv.id);
    console.log(`✓ 当前版本已切换为 ${bankId} v${bankVersion}`);
    return 0;
  }
  if (cmd === 'list') {
    const rows = await listBankVersions(prisma);
    if (!rows.length) console.log('还没有装入任何题库包。');
    for (const r of rows) {
      const counts = (r.manifest as { counts?: { total?: number } }).counts;
      console.log(`${r.isCurrent ? '★' : ' '} ${r.bankId} v${r.bankVersion}  ${counts?.total ?? '?'} 道题  装入于 ${r.loadedAt.toISOString().slice(0, 16)}`);
    }
    return 0;
  }
  return usage();
}

function usage(): number {
  console.log('用法：npm run bank -- <load 目录 [--no-activate] | activate 题库编号 版本号 | list | validate 目录>');
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    if (e instanceof BankLoadError) {
      for (const f of e.findings.slice(0, 40)) console.log(`✗ ${f.where}：${f.message}`);
      console.log(`✗ ${e.message}`);
    } else console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
