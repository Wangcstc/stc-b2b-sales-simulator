/**
 * 题库装入器（柜子一侧）—— 把一个题库包装进柜子的数据库。
 *
 * ★ 装入分两段 ★
 *   第 1–6 步（校验）在题库工具包 `validateBank` 里：结构、格式版本、校验和、考纲、引用、计数。
 *   第 7–9 步在这里：写进数据库（暂存、非当前）→ 冒烟 → 原子切换为当前版本。
 * 数据库是柜子的，题库工具包不该认识它，所以后半段放在柜子里。
 *
 * ★ 柜子不认识任何具体题目 ★ 题型行（Persona）按标准层的考纲写，题目行（PersonaVariant）
 * 按题库包写。这个文件里不出现任何题目编号。
 *
 * ★ 题库包一经装入不再修改 ★ 同一个题库同一个版本号再装一次：内容一样就跳过；内容不一样就拒绝。
 *
 * 页面、接口、命令行（`npm run bank`）调用的都是这里的同一组函数。
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash, readBank, validateBank, type Finding, type Persona } from '../../bank-kit/index';
import { SYLLABUS_VERSION, syllabusType } from '../../standards/index';

export class BankLoadError extends Error {
  constructor(
    message: string,
    readonly findings: Finding[] = [],
  ) {
    super(message);
    this.name = 'BankLoadError';
  }
}

export interface LoadResult {
  status: 'loaded' | 'already-loaded';
  bankVersionId: string;
  bankId: string;
  bankVersion: string;
  questions: number;
  activated: boolean;
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

/**
 * 冒烟：每道题都要能拼出买家扮演提示词的「明牌」段。
 * 买家扮演会读 open_card 的这些字段与产品名；缺了，开局那一刻才炸，不如装入时就拦下。
 */
export function smokeQuestion(q: Persona): string[] {
  const o = q.open_card as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ['name', 'country', 'company', 'buyer_level', 'registered_at', 'email', 'inquiry_text']) {
    if (typeof o[k] !== 'string' || !(o[k] as string).trim()) out.push(`open_card.${k} 缺失`);
  }
  for (const k of ['categories', 'tags']) if (!Array.isArray(o[k])) out.push(`open_card.${k} 应为数组`);
  if (!q.product?.name) out.push('product.name 缺失');
  return out;
}

/** 装入一个题库包。默认装完就切换为当前版本；`activate: false` 只装不切 */
export async function loadBank(prisma: PrismaClient, dir: string, opts: { activate?: boolean } = {}): Promise<LoadResult> {
  const activate = opts.activate ?? true;

  // 第 1–6 步：校验
  const check = validateBank(dir);
  if (!check.ok) throw new BankLoadError(`题库包校验不通过：${check.errors.length} 处`, check.errors);
  const bank = readBank(dir);
  const { manifest } = bank;
  const fingerprint = contentHash(readFileSync(join(dir, 'checksums.json')));

  // 已经装过同一版本
  const existing = await prisma.bankVersion.findUnique({
    where: { bankId_bankVersion: { bankId: manifest.bank_id, bankVersion: manifest.bank_version } },
  });
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new BankLoadError(
        `题库 ${manifest.bank_id} 的 v${manifest.bank_version} 已经装过，但内容不一样。题库包一经装入不再修改，改了题请升题库版本号。`,
      );
    }
    if (activate && !existing.isCurrent) await activateBankVersion(prisma, existing.id);
    return {
      status: 'already-loaded',
      bankVersionId: existing.id,
      bankId: manifest.bank_id,
      bankVersion: manifest.bank_version,
      questions: manifest.counts.total,
      activated: activate || existing.isCurrent,
    };
  }

  // 冒烟（在写库之前做，不过就不写）
  const smoke = bank.personas.flatMap((q) => smokeQuestion(q).map((message) => ({ where: `personas/${q.id}.json`, message })));
  if (smoke.length) throw new BankLoadError(`冒烟不通过：${smoke.length} 处`, smoke);

  // 第 7 步：写进数据库（暂存：题目先全部不启用）
  const bgByPersona = new Map(bank.bgPackages.map((b) => [b.persona_id, b]));
  const bankVersionId = await prisma.$transaction(
    async (tx) => {
      const bv = await tx.bankVersion.create({
        data: {
          bankId: manifest.bank_id,
          bankVersion: manifest.bank_version,
          formatVersion: manifest.format_version,
          syllabusVersion: manifest.syllabus_version,
          drawerVersion: manifest.drawer_version,
          generator: manifest.generator ?? null,
          packedAt: new Date(manifest.created_at),
          fingerprint,
          manifest: json(manifest),
          coverage: json(bank.coverage),
        },
      });

      // 题型行：按考纲写，不按题目写
      const personaIdByCode = new Map<string, string>();
      for (const code of [...new Set(bank.personas.map((q) => q.skeleton.type_code))].sort()) {
        const t = syllabusType(code)!; // validateBank 已保证存在
        const fields = {
          name: t.name,
          tests: t.tests,
          sessionType: t.session_type === 'followup' ? ('FOLLOWUP' as const) : ('INQUIRY' as const),
          difficulty: t.default_difficulty,
          activeForces: json(t.active_forces),
          naForces: json(t.na_forces),
          syllabus: `v${SYLLABUS_VERSION}`,
        };
        const row = await tx.persona.upsert({ where: { code }, update: fields, create: { code, ...fields } });
        personaIdByCode.set(code, row.id);
      }

      for (const q of bank.personas) {
        const poolType = q.pool_type === 'admission_exam' ? ('ADMISSION_EXAM' as const) : ('DRILL' as const);
        const v = await tx.personaVariant.create({
          data: {
            personaId: personaIdByCode.get(q.skeleton.type_code)!,
            variantId: q.id,
            bankVersionId: bv.id,
            enabledInBank: q.active !== false,
            active: false,
            openCard: json(q.open_card),
            hiddenCard: json(q.hidden_card),
            product: json(q.product),
            distractors: json(q.distractors ?? []),
            initState: json(q.init_state),
            exitLines: json(q.exit_lines),
            quoteReactions: json(q.quote_reactions),
            languageStyle: q.language_style,
            presetElements: json(q.preset_elements ?? []),
            difficulty: q.difficulty ?? null,
            examOnly: poolType === 'ADMISSION_EXAM',
            poolType,
            poolVersion: `${manifest.bank_id}@${manifest.bank_version}`,
          },
        });
        const bg = bgByPersona.get(q.id);
        if (bg) {
          await tx.bgPackage.create({
            data: {
              variantId: v.id,
              aiReport: json(bg.ai_report),
              website: json(bg.website),
              social: json(bg.social),
              contacts: json(bg.contacts),
            },
          });
        }
      }
      return bv.id;
    },
    { timeout: 120_000 },
  );

  // 第 9 步：切换
  if (activate) await activateBankVersion(prisma, bankVersionId);
  return {
    status: 'loaded',
    bankVersionId,
    bankId: manifest.bank_id,
    bankVersion: manifest.bank_version,
    questions: manifest.counts.total,
    activated: activate,
  };
}

/**
 * 把一个已装入的题库版本切换为当前版本（也用于回滚）。
 *
 * ★ 一个事务里做完 ★ 中途失败就整个不生效，不会出现「一半题是新版、一半是旧版」。
 * ★ 正在打的局不受影响 ★ 局指着的是题目行本身，不是「当前版本」；切换后新开的局才用新版本。
 */
export async function activateBankVersion(prisma: PrismaClient, bankVersionId: string): Promise<void> {
  await prisma.$transaction([
    prisma.personaVariant.updateMany({ where: { active: true }, data: { active: false } }),
    prisma.personaVariant.updateMany({ where: { bankVersionId, enabledInBank: true }, data: { active: true } }),
    prisma.bankVersion.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } }),
    prisma.bankVersion.update({ where: { id: bankVersionId }, data: { isCurrent: true } }),
  ]);
}

export async function currentBankVersion(prisma: PrismaClient) {
  return prisma.bankVersion.findFirst({ where: { isCurrent: true } });
}

export async function listBankVersions(prisma: PrismaClient) {
  return prisma.bankVersion.findMany({
    orderBy: [{ loadedAt: 'desc' }],
    select: { id: true, bankId: true, bankVersion: true, isCurrent: true, loadedAt: true, packedAt: true, generator: true, manifest: true },
  });
}
