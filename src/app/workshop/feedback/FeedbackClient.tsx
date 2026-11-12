'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FeedbackView, QuestionStats } from '@/lib/workshop/feedback';
import ChoiceCard, { postJson } from '../ChoiceCard';

/**
 * 回流页（阶段 6）：上半部分是回炉建议（选择题），下半部分是每道题的实战统计。
 * 建议只在攒够一批有分的局之后才出；拍过板的同一条建议，再攒够一批新局才再提。
 */

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);

function StatsTable({ stats, minSessions }: { stats: QuestionStats[]; minSessions: number }) {
  const played = stats.filter((s) => s.sessions > 0);
  if (!played.length) return <div className="small muted">当前版本的题还没有人打过。业务员练起来之后，这里会按题列出通过率、平均分、常见失分点。</div>;
  return (
    <div className="table-wrap">
      <table className="team-table">
        <thead>
          <tr>
            <th>题</th>
            <th className="num-col">局数（有分）</th>
            <th className="num-col">通过率</th>
            <th className="num-col">平均分</th>
            <th className="num-col">红线</th>
            <th className="num-col">客户放弃</th>
            <th>常见失分点</th>
          </tr>
        </thead>
        <tbody>
          {played.map((s) => (
            <tr key={s.rowId}>
              <td className="small">
                <span className="mono">{s.variantId}</span> {s.typeName}
                <span className="tiny faint"> · {s.pool === 'exam' ? '考试' : '演习'}</span>
              </td>
              <td className="num-col">
                {s.sessions}（{s.scored}）{s.scored < minSessions && <span className="tiny faint"> 样本少</span>}
              </td>
              <td className="num-col">{pct(s.passRate)}</td>
              <td className="num-col">{s.avgScore === null ? '—' : Math.round(s.avgScore)}</td>
              <td className="num-col">{pct(s.redlineRate)}</td>
              <td className="num-col">{pct(s.gaveUpRate)}</td>
              <td className="small">
                {[
                  s.weakestForce ? `${s.weakestForce.label}最弱（平均 ${s.weakestForce.avg.toFixed(1)}）` : '',
                  ...s.rareCards.map((c) => `暗牌 ${c.key} 只有 ${pct(c.rate)} 挖出`),
                  s.onePhrase ? `暗牌 ${s.onePhrase.key} 被一句话破解 ${pct(s.onePhrase.share)}` : '',
                ]
                  .filter(Boolean)
                  .join('；') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function FeedbackClient({ view }: { view: FeedbackView }) {
  const router = useRouter();
  const [done, setDone] = useState<string[]>([]);
  if (!view.version) return <div className="card small">还没有题库。装入题库、业务员练起来之后，这里会出每道题的实战统计。</div>;
  const r = view.rules;
  return (
    <div className="ws-grid">
      <div className="card ws-grid">
        <b>
          回炉建议 · <span className="mono">{view.version.bankId} v{view.version.bankVersion}</span>
        </b>
        <div className="small muted">
          每道题攒够 {r.min_sessions} 局有分的局才判：通过率不低于 {pct(r.too_easy_pass_rate)} 算太容易、不高于 {pct(r.too_hard_pass_rate)} 算太难（过 {r.pass_score} 分算通过）；
          某张暗牌 {pct(r.one_phrase_share)} 以上的解锁都是同一句话，算被套话破解。只出建议，你拍板；
          {view.canReworkAny ? '「回炉」会把题退回抽屉，让模型照着统计改一版，改完到「确认」页等你。' : '这套部署在托管平台上，回炉要在本机的题库工坊里做；这里可以降为演习、下架或保留。'}
        </div>
        {done.map((d) => (
          <div key={d} className="small">
            ✓ {d}
          </div>
        ))}
        {!view.suggestions.length && <div className="small">现在没有要你拍板的题。</div>}
      </div>
      {view.suggestions.map((s) => (
        <ChoiceCard
          key={`${s.stats.variantId}-${s.kind}`}
          question={s.question}
          reason={s.reason}
          options={s.options}
          otherHint="写下你的意见（记进管理留痕；题先不动）"
          onAnswer={async (key, text) => {
            const res = await postJson<{ say: string }>('/api/workshop/feedback', { variantId: s.stats.variantId, kind: s.kind, option: key, text });
            setDone((d) => [...d, `${s.stats.variantId}：${res.say}`]);
            router.refresh();
          }}
        />
      ))}
      <div className="card ws-grid">
        <b>每道题的实战统计</b>
        <div className="small muted">同一道题跨版本合并算；回炉改过暗牌的，只算改过之后的局。</div>
        <StatsTable stats={view.stats} minSessions={r.min_sessions} />
      </div>
    </div>
  );
}
