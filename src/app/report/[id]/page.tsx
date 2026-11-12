import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { guardView } from '@/lib/session-guard';
import { assertNoLGrade } from '@/lib/report';
import AppShell from '@/components/AppShell';
import { canSeeEveryone } from '@/lib/current-user';
import Help from '@/components/Help';
import PageHelp from '@/components/PageHelp';
import { FORCES, FORCE_LABEL, type Force, type ForceResult } from '../../../../engine/types';
import CalibrationPanel, { type ForceRow } from './CalibrationPanel';

export const dynamic = 'force-dynamic';

/** 极简 markdown 渲染：报告结构是我们自己生成的，够用就好，不引依赖 */
function render(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`(.+?)`/g, '<code>$1</code>');

  const html: string[] = [];
  let inTable = false;

  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();

    if (line.startsWith('|')) {
      if (/^\|[\s|:-]+\|$/.test(line)) continue;
      if (!inTable) {
        html.push('<table>');
        inTable = true;
      }
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((c) => '<td>' + inline(c.trim()) + '</td>');
      html.push('<tr>' + cells.join('') + '</tr>');
      continue;
    }
    if (inTable) {
      html.push('</table>');
      inTable = false;
    }

    if (line.startsWith('### ')) html.push('<h3>' + inline(line.slice(4)) + '</h3>');
    else if (line.startsWith('## ')) html.push('<h2>' + inline(line.slice(3)) + '</h2>');
    else if (line.startsWith('# ')) html.push('<h1>' + inline(line.slice(2)) + '</h1>');
    else if (line.startsWith('> ')) html.push('<blockquote>' + inline(line.slice(2)) + '</blockquote>');
    else if (line.startsWith('- ')) html.push('<li>' + inline(line.slice(2)) + '</li>');
    else if (line !== '') html.push('<p>' + inline(line) + '</p>');
  }
  if (inTable) html.push('</table>');
  return html.join('\n');
}

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 报告能看的范围比对话宽：本人 + 主管（主管要盘人）
  const g = await guardView(id);
  if (!g.ok) {
    if (g.status === 401) redirect('/signin');
    notFound();
  }

  const s = await prisma.session.findUnique({ where: { id }, include: { score: true, calibration: true } });
  if (!s) notFound();

  if (!s.score) {
    return (
      <AppShell current="/" narrow>
        <div className="page-head" style={{ marginBottom: 10 }}>
          <h1>还没有报告</h1>
        </div>
        <p className="muted small">这一局还没评分。回到对话页点「结束并复盘」。</p>
        <Link href={'/drill/' + id} className="small">← 回到对话</Link>
      </AppShell>
    );
  }

  // 出页面前再拦一次 L 字样（需求 1.3 铁律）
  assertNoLGrade(s.score.reportMd ?? '');

  return (
    <AppShell current="/" narrow>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
        <Link href={'/drill/' + id} className="small muted">
          ← 回到对话
        </Link>
        {/* ★ 只说这一页怎么用，评分口径在报告正文里 ★ */}
        <PageHelp page="report" />
      </div>
      {/* ★ 2026-08-28 去框 ★ 一整页只有这一块内容，上面就是页头——
          框住它等于用一个边界把"整页"和"整页"分开。padding 也去掉：
          正文左边缘和页头、和别处的表首列共用一条基线。 */}
      <article className="report" dangerouslySetInnerHTML={{ __html: render(s.score.reportMd ?? '') }} />

      {/* ★ 标尺校准只给主管 ★ 让被打分的人自己判分，标尺就没有基准可言了 */}
      {canSeeEveryone(g.user) && (
        <CalibrationPanel
          sessionId={id}
          systemTier={s.score.tier}
          saved={Boolean(s.calibration)}
          forces={forceRows(s.score.forces)}
        />
      )}
    </AppShell>
  );
}

/**
 * 从存好的七力结果里挑出可校准的行。
 * INSUFFICIENT（证据不足）不进表——那不是判重了判轻了，是压根没得判，
 * 把它摆进对照会污染「差异 ≤1 比例」这个数。
 */
function forceRows(raw: unknown): ForceRow[] {
  const forces = (raw ?? {}) as Partial<Record<Force, ForceResult>>;
  const rows: ForceRow[] = [];
  for (const key of FORCES) {
    const r = forces[key];
    if (!r || r.score === 'INSUFFICIENT') continue;
    rows.push({ key, label: FORCE_LABEL[key], system: String(r.score), anchor: r.anchor ?? '' });
  }
  return rows;
}
