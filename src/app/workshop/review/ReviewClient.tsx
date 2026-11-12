'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { CardView } from '@/lib/workshop/service';
import ChoiceCard, { postJson } from '../ChoiceCard';

/**
 * 确认页（需求文档第八节）：选择题确认队列。
 *   ① 每张卡 3 个选项 + 「其他」，推荐项排第一、写明理由（理由来自质检与机器试打的实际结果）；
 *   ④ 选「其他」写的意见交给模型照着改，改完重新质检、回到这里，并标出改了哪里；
 *   ⑤ 批量通过只给演习题，考试题必须逐道确认；
 *   ⑥ 每次选择都留痕（谁、什么时候、选了什么、写了什么）。
 */

function Summary({ v }: { v: CardView }) {
  const s = v.summary;
  if (!s) return v.material ? <div className="small muted">素材：<span className="mono">{v.material}</span></div> : null;
  return (
    <div className="ws-grid" style={{ gap: 8 }}>
      <div className="ws-row small">
        <span className="chip">{s.kind}</span>
        {s.parent && <span className="tiny faint">母题 {s.parent}</span>}
        <span className="chip accent">{s.type}</span>
        <span className="chip">{s.difficulty}</span>
        <span className={`chip ${s.pool === '考试' ? 'warn' : ''}`}>{s.pool}</span>
      </div>
      <dl className="ws-kv small">
        <dt>买家</dt>
        <dd>
          {s.buyer} · {s.company} · {s.country}
        </dd>
        <dt>考哪几点</dt>
        <dd>{s.tests}</dd>
        <dt>机器试打</dt>
        <dd>
          暗牌 {s.hiddenCards} 张，机制难度指数 {s.index ?? '—'}
          {s.calibration.length > 0 && (
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {s.calibration.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
        </dd>
        {s.warnings.length > 0 && (
          <>
            <dt>质检提醒</dt>
            <dd>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {s.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
      <div>
        <div className="tiny faint">开场询盘</div>
        <div className="ws-quote small">{s.inquiry}</div>
      </div>
      {v.card.changes && v.card.changes.length > 0 && (
        <div className="small">
          <b>这一版改了：</b>
          {v.card.changes.join('；')}
        </div>
      )}
    </div>
  );
}

export default function ReviewClient({ cards }: { cards: CardView[] }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  if (!cards.length) {
    return (
      <div className="card small">
        {msg && <div style={{ marginBottom: 6 }}>✓ {msg}</div>}
        没有等你确认的卡。加工中的题出来后会出现在这里；进度看 <Link href="/workshop/jobs">加工</Link> 页，确认采用的题到 <Link href="/workshop/bank">题库</Link> 页上架。
      </div>
    );
  }
  const batches = [...new Set(cards.map((c) => c.batchId))];
  return (
    <div className="ws-grid">
      {msg && <div className="card small">{msg}</div>}
      {batches.map((id) => {
        const list = cards.filter((c) => c.batchId === id);
        const drill = list.filter((c) => c.card.batchable).length;
        return (
          <section key={id} className="ws-grid">
            <div className="ws-row" style={{ justifyContent: 'space-between' }}>
              <b>
                批次 <span className="mono">{id}</span>：{list.length} 张卡
              </b>
              {drill > 1 && (
                <button
                  className="ghost"
                  onClick={async () => {
                    try {
                      const r = await postJson<{ answered: number }>('/api/workshop/review', { batchId: id, all: true });
                      setMsg(`已按推荐处理 ${r.answered} 张演习题的卡；考试题的卡还要逐道确认。`);
                      router.refresh();
                    } catch (e) {
                      setMsg((e as Error).message);
                    }
                  }}
                >
                  这一批的 {drill} 道演习题全部按推荐处理
                </button>
              )}
            </div>
            {list.map((v) => (
              <ChoiceCard
                key={v.card.id}
                question={v.card.question}
                reason={v.card.reason}
                options={v.card.options}
                otherHint={v.card.kind === 'use_question' ? '写修改意见，模型照着改，改完重新质检、再回到这里' : v.card.kind === 'redact_suspect' ? '写要抹掉的词，逗号隔开' : '写一个新的预算金额（元）'}
                onAnswer={async (key, text) => {
                  await postJson('/api/workshop/review', { batchId: id, cardId: v.card.id, option: key, text });
                  router.refresh();
                }}
              >
                <Summary v={v} />
              </ChoiceCard>
            ))}
          </section>
        );
      })}
    </div>
  );
}
