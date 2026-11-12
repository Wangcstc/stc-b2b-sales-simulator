import { prisma } from '@/lib/db';
import { getCurrentUser, canSeeEveryone } from '@/lib/current-user';
import * as XLSX from 'xlsx';
import type { SessionFacts, ScoreOutput, Force } from '../../../../engine/types';
import { SIX_ELEMENTS, FORCES, FORCE_LABEL } from '../../../../engine/types';
import { businessDay } from '@/lib/business-day';
import { sessionModeLabel } from '@/lib/session-mode';
import { WEEKLY_EXAM_CONFIG, weekRangeText } from '@/lib/weekly-exam';
import { variantDifficulty } from '@/lib/variant-difficulty';

/**
 * 演习台账导出（需求 12.2 / 12.3）
 *
 * ★ 存储隔离铁律（需求 1.3 / 12.1）★
 * 这里只读本库，且导出的 ID 一律 `D-` 前缀。
 * 演习系统**永不写入** wang-grade-coach-memory —— 演习分不能混进正式定级样本池。
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new Response('请先在选人页选择你是谁', { status: 401 });

  // 主管导全员，新人只导自己的——台账是用来盘人的，不该让被盘的人互相看
  const everyone = canSeeEveryone(user);

  const sessions = await prisma.session.findMany({
    where: everyone ? undefined : { userId: user.id },
    orderBy: { createdAt: 'desc' },
    include: { user: true, variant: { include: { persona: true } }, score: true },
  });
  const attempts = await prisma.examAttempt.findMany({
    where: everyone ? undefined : { userId: user.id },
    include: { user: true },
    orderBy: { createdAt: 'desc' },
  });
  const decisions = await prisma.accessDecision.findMany({
    where: everyone ? undefined : { subjectId: user.id },
    include: { subject: true, operator: true },
    orderBy: { createdAt: 'desc' },
  });
  // 正式业务员的周考留档（2026-08-24 加）。与「准入考试记录」分成两张表：
  // 两套规则服务两种人，混在一张表里，「达标」那一列会有两种含义。
  const weeklyRecords = await prisma.weeklyExamRecord.findMany({
    where: everyone ? undefined : { userId: user.id },
    include: { user: true },
    orderBy: [{ weekStart: 'desc' }, { userId: 'asc' }],
  });

  const drillRows = sessions.map((s) => {
    const facts = s.facts as unknown as SessionFacts;
    const forces = (s.score?.forces ?? {}) as ScoreOutput;
    const q = facts.quotes?.[facts.quotes.length - 1];

    const row: Record<string, string | number | null> = {
      演习ID: s.drillId,
      业务员: s.user.name,
      日期: businessDay(s.createdAt),
      模式: sessionModeLabel(s.mode),
      局型: s.type === 'FOLLOWUP' ? '跟进局' : '探需局',
      人设骨架: s.variant.persona.code,
      变体: s.variant.variantId,
      题池: s.variant.poolType,
      题池版本: s.variant.poolVersion,
      评分版本: s.score?.scoreRuleVersion ?? '',
      难度: variantDifficulty(s.variant),
    };

    for (const f of FORCES) {
      const item = forces[f as Force];
      row[FORCE_LABEL[f as Force]] = item ? (typeof item.score === 'number' ? item.score : item.score) : 'NA';
    }

    row['可评维度数'] = s.score?.evaluableCount ?? '';
    row['覆盖率'] = s.score ? Math.round(s.score.coverage * 100) / 100 : '';
    row['原始演习局分'] = s.score?.rawScore ?? '';
    row['演习段位D'] = s.score?.tier ?? '';
    row['即时推进度'] = s.score?.progress ?? '';
    row['复盘作答质量'] = s.score?.answerQuality ?? '';
    const flags = (s.score?.flags ?? []) as string[];
    row['红旗'] = flags
      .map((f) => (f === 'high_skill_zero_progress' ? '高招式·零推进' : '高分·零认知'))
      .join('、');

    for (const el of SIX_ELEMENTS) {
      const r = facts.elements?.[el];
      // 三态：老局的 facts 没有 status 列，从 collected 推（同 engine/types.ts 的 statusOf）
      const st = r?.status ?? (r?.collected ? 'collected' : 'unasked');
      row[`六要素-${el}`] =
        st === 'collected'
          ? r?.source === 'volunteered'
            ? '客户主动给'
            : r?.source === 'preset'
              ? '前情已定'
              : `第${r?.gotTurn ?? r?.turn}轮问出`
          : st === 'asked_no_answer'
            ? `第${r?.askedTurn}轮问了未获取`
            : '未询问';
    }
    row['收齐轮数'] = facts.turnsToCollectAll ?? '';
    row['报价金额'] = q?.total ?? '';
    row['报价档位'] = q?.tier ?? '';
    row['格式合规'] = q ? (q.formatCompliant ? '是' : '否') : '';
    // 列名从「数量失真」改掉：它读起来像系统报错，实际是数量陷阱命中（2026-08-19 反馈）
    row['未问出真实数量'] = q ? (q.quantityMismatch ? '是' : '否') : '';
    row['报价时数量已确认'] = q ? (q.quantityConfirmed === false ? '否' : '是') : '';
    row['红线R1'] = facts.redlines?.includes('R1') ? '触发' : '';
    row['红线R2'] = facts.redlines?.includes('R2') ? '触发' : '';
    row['红线R3'] = facts.redlines?.includes('R3') ? '触发' : '';
    row['红线R4-中文作答'] = facts.redlines?.includes('R4') ? '触发' : '';
    row['背调发起'] = facts.bgInitiated ? '是' : '否';
    row['背调识破预埋错误'] = facts.bgErrorDetected ? '是' : '否';
    row['解锁暗牌数'] = facts.unlockedCards?.length ?? 0;
    row['跟进用到第几级'] = facts.followupLevelsUsed?.length
      ? facts.followupLevelsUsed[facts.followupLevelsUsed.length - 1]!.level
      : '';
    row['结局'] = s.exitReason ?? (q ? '正常报价' : '未报价');

    return row;
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(drillRows), '演习局记录');
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      attempts.map((attempt) => ({
        考试ID: attempt.id,
        业务员: attempt.user.name,
        上海业务日: attempt.businessDay ?? attempt.day,
        用途: attempt.attemptType,
        组号: attempt.groupNo ?? '',
        训练周期: attempt.trainingCycleId ?? '',
        有效局数: attempt.validSessionCount ?? '',
        结论: attempt.verdict ?? '进行中',
        题池版本: attempt.poolVersion,
        评分版本: attempt.scoreRuleVersion,
        // ★ 原来这儿还有「失败规则」「五道闸门」两列 ★ 那是 v3.0 判定的留档字段，
        // 每日考试从不写它们，导出来永远是 [] 和 {}。2026-08-24 随 v3 判定一起删。
      })),
    ),
    '准入考试记录',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      decisions.map((decision) => ({
        业务员: decision.subject.name,
        系统建议: decision.recommendedStatus,
        实际应用: decision.appliedStatus,
        生效业务日: decision.effectiveDay,
        人工覆盖: decision.manualOverride ? '是' : '否',
        操作人: decision.operator?.name ?? '系统',
        覆盖到期: decision.overrideUntil?.toISOString() ?? '',
        原因: decision.reason ?? '',
        关联考试: decision.attemptIds.join('、'),
        题池版本: decision.poolVersion,
        评分版本: decision.scoreRuleVersion,
      })),
    ),
    '询盘权限决策',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      weeklyRecords.map((record) => ({
        业务员: record.user.name,
        周次: weekRangeText(record.weekStart),
        周一: record.weekStart,
        周日: record.weekEnd,
        考试场次: record.examCount,
        要求场次: WEEKLY_EXAM_CONFIG.examsPerWeek,
        出分局数: record.preciseCount,
        要求局数: WEEKLY_EXAM_CONFIG.sessionsPerWeek,
        本周考试中位数: record.medianScore ?? '',
        // ★ 三态要能在表格里分得出来 ★ null 是「这一周还没过完」，
        // 导成空白会被读成「没考满」——那是两件事
        本周要求: record.met === true ? '已完成' : record.met === false ? '未考满' : '进行中',
        说明: (record.detail as { text?: string } | null)?.text ?? '',
      })),
    ),
    '正式业务员周考',
  );

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const day = businessDay();

  // ★ HTTP 头只装得下 latin-1 ★ 中文文件名直接塞进去会 500（"全"是 U+5168）。
  // 所以 filename 给纯 ASCII 兜底，中文走 RFC 5987 的 filename*，浏览器优先用后者。
  const asciiName = `drill-ledger-${everyone ? 'all' : user.code}-${day}.xlsx`;
  const cnName = `演习台账-${everyone ? '全员' : user.name}-${day}.xlsx`;

  return new Response(new Uint8Array(buf), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition':
        `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(cnName)}`,
    },
  });
}
