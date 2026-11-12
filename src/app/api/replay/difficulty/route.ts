import { NextResponse } from 'next/server';
import { getCurrentUser, canSeeEveryone } from '@/lib/current-user';
import { audit } from '@/lib/admin-audit';
import { ADMISSION_CONFIG } from '@/lib/admission-v11';
import { DIFFICULTY_BOUNDS, normalizeFactor, applyDifficulty, rawNeededFor } from '../../../../../engine/difficulty';
import {
  difficultyStatus,
  scheduleDifficulty,
  nextEffectiveFrom,
  effectiveFromLabel,
} from '@/lib/difficulty-setting';

/**
 * 难度系数（王老师 2026-08-23 裁定）。
 *
 * 它只干一件事：调「跑一局拿到 65 分有多难」。
 * **门槛永远是 65**，系数只折算局分。
 *
 * ★ 只给主管 ★ 与 `/api/replay` 同一道闸：把评分松紧摆给被打分的人看，
 * 等于告诉他今天可以松一点。
 */
async function requireManager() {
  const user = await getCurrentUser();
  if (!user) return { denied: NextResponse.json({ error: '请先登录' }, { status: 401 }) };
  if (!canSeeEveryone(user)) {
    return { denied: NextResponse.json({ error: '这是主管的工具' }, { status: 403 }) };
  }
  return { user };
}

/** 界面上摆的对照表：这几个原始分，在这个系数下会变成多少 */
const SAMPLES = [50, 60, 65, 70, 80, 90] as const;

export async function GET(req: Request) {
  const { denied } = await requireManager();
  if (denied) return denied;

  // ?factor=1.2 时返回"如果调成 1.2 会怎样"的预览；不带就是当前生效值
  const url = new URL(req.url);
  const raw = url.searchParams.get('factor');
  const status = await difficultyStatus();
  const factor = raw === null ? status.current : normalizeFactor(raw);
  const pass = ADMISSION_CONFIG.medianScoreMin;

  return NextResponse.json({
    bounds: DIFFICULTY_BOUNDS,
    current: status.current,
    pending: status.pending,
    history: status.history,
    /** ★ 门槛是定数，一起发出去让界面写死显示 ★ */
    passMark: pass,
    preview: {
      factor,
      /** 这个系数下，要拿到 65 分，原始水平得打到多少——界面上最该看的一个数 */
      rawNeededForPass: rawNeededFor(pass, factor),
      /** 几个样本分的折算对照 */
      table: SAMPLES.map((baseline) => ({ baseline, final: applyDifficulty(baseline, factor) })),
    },
    nextEffectiveFrom: effectiveFromLabel(await nextEffectiveFrom()),
  });
}

export async function PUT(req: Request) {
  const { denied, user } = await requireManager();
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { factor?: unknown; note?: unknown };
  const raw = body.factor;

  // ★ 显式拒绝，不静默兜底 ★ `normalizeFactor` 遇到脏值会退回 1.0——
  // 那是出分路径上的保命策略，但在"人正在设置它"这条路径上，
  // 悄悄把 0.05 变成 1.0 等于按了一个他没按的按钮。
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return NextResponse.json({ error: '难度系数必须是数字' }, { status: 400 });
  }
  if (raw < DIFFICULTY_BOUNDS.min || raw > DIFFICULTY_BOUNDS.max) {
    return NextResponse.json(
      { error: `难度系数只能在 ${DIFFICULTY_BOUNDS.min} 到 ${DIFFICULTY_BOUNDS.max} 之间` },
      { status: 400 },
    );
  }

  const before = await difficultyStatus();
  const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : null;
  const { factor, effectiveFrom } = await scheduleDifficulty({ factor: raw, setBy: user!.id, note });
  const pass = ADMISSION_CONFIG.medianScoreMin;

  await audit({
    actorId: user!.id,
    action: 'DIFFICULTY_SET',
    before: `系数 ${before.current}（要打出 ${rawNeededFor(pass, before.current)} 的水平才拿得到 ${pass} 分）`,
    after: `系数 ${factor}（要打出 ${rawNeededFor(pass, factor)} 的水平才拿得到 ${pass} 分），${effectiveFromLabel(effectiveFrom)}起生效`,
    note,
  });

  return NextResponse.json({
    factor,
    rawNeededForPass: rawNeededFor(pass, factor),
    passMark: pass,
    effectiveFrom,
    effectiveFromLabel: effectiveFromLabel(effectiveFrom),
  });
}
