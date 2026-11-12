'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { BatchRow, ItemRow } from '@/lib/workshop/service';
import { BATCH_STATUS, ITEM_STATUS, QUESTION_STATUS } from '@/lib/workshop/labels';
import ChoiceCard, { postJson } from '../ChoiceCard';

/**
 * 加工页（需求文档 5.2）：每一批、每一份素材走到哪道工序、卡在哪、为什么。
 * 有批次在跑就每 3 秒刷新一次；都停了就不再刷。
 */

const yuan = (n: number) => (n <= 0 ? '0 元' : n < 0.1 ? '不到 0.1 元' : `${n.toFixed(n < 10 ? 2 : 0)} 元`);

function Items({ batchId, tick }: { batchId: string; tick: number }) {
  const [items, setItems] = useState<ItemRow[] | null>(null);
  useEffect(() => {
    fetch(`/api/workshop/batch?id=${encodeURIComponent(batchId)}`)
      .then((r) => r.json())
      .then((j: { items?: ItemRow[] }) => setItems(j.items ?? []))
      .catch(() => setItems([]));
  }, [batchId, tick]);
  if (!items) return <div className="small muted">读取中…</div>;
  return (
    <div className="table-wrap">
      <table className="team-table">
        <thead>
          <tr>
            <th>素材</th>
            <th>状态</th>
            <th>题型</th>
            <th>出的题</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id}>
              <td className="mono small">
                {it.id} · {it.label}
              </td>
              <td>
                <span className={`chip ${ITEM_STATUS[it.status].tone}`}>{ITEM_STATUS[it.status].label}</span>
              </td>
              <td className="small">{it.type ?? '—'}</td>
              <td className="small">
                {it.questions.length
                  ? it.questions.map((q) => (
                      <div key={q.qid}>
                        <span className="mono">{q.qid}</span> {q.kind === 'mother' ? '母题' : '变体'}·{q.pool}{' '}
                        <span className={`chip ${QUESTION_STATUS[q.status].tone}`}>{QUESTION_STATUS[q.status].label}</span>
                        {q.packed && <span className="tiny faint"> 已上架 {q.packed}</span>}
                      </div>
                    ))
                  : '—'}
              </td>
              <td className="small muted">{it.reason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BatchCard({ b, tick, refresh }: { b: BatchRow; tick: number; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const running = b.run?.running ?? false;
  const failed = b.items.failed ?? 0;
  const counts = Object.entries(b.items)
    .map(([k, n]) => `${ITEM_STATUS[k as keyof typeof ITEM_STATUS]?.label ?? k} ${n}`)
    .join('　');
  const qs = Object.entries(b.questions)
    .map(([k, n]) => `${QUESTION_STATUS[k as keyof typeof QUESTION_STATUS]?.label ?? k} ${n}`)
    .join('　');

  async function act(action: string) {
    setErr(null);
    try {
      await postJson('/api/workshop/batch', { action, batchId: b.id });
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="card ws-grid">
      <div className="ws-row" style={{ justifyContent: 'space-between' }}>
        <div>
          <b className="mono">{b.id}</b>{' '}
          <span className={`chip ${running ? 'accent' : b.status === 'paused' ? 'warn' : ''}`}>{running ? '加工中' : BATCH_STATUS[b.status] ?? b.status}</span>
          {b.pending > 0 && (
            <Link href="/workshop/review" className="chip warn" style={{ marginLeft: 6 }}>
              {b.pending} 张卡等你确认
            </Link>
          )}
        </div>
        <span className="small muted">已花 {yuan(b.costCny)}</span>
      </div>
      {running && <div className="small">正在：{b.run?.progress}</div>}
      {!running && b.run?.error && <div className="small choice-err">上一轮停下了：{b.run.error}</div>}
      <div className="small">素材：{counts || '—'}</div>
      {qs && <div className="small">题目：{qs}</div>}
      {b.lastLog && <div className="tiny faint">最近：{b.lastLog}</div>}
      {!b.hasProducts && <div className="small choice-err">这一批没有产品表，开不了工：到「投料」页重新投一批，带上产品表。</div>}
      <div className="ws-row">
        <button className="ghost" onClick={() => setOpen((o) => !o)}>
          {open ? '收起明细' : '看每一份素材'}
        </button>
        {!running && b.hasProducts && b.status !== 'stopped' && b.hasWork && (
          <button className="ghost" onClick={() => act('continue')}>
            继续加工
          </button>
        )}
        {!running && b.processLimit !== undefined && b.notStarted > 0 && (
          <button className="ghost" onClick={() => act('release')}>
            {b.processLimit === 0 ? `开始加工这 ${b.notStarted} 份` : `接着做剩下的 ${b.notStarted} 份`}
          </button>
        )}
        {b.unpacked > 0 && (
          <Link href="/workshop/bank">
            <button className="ghost">{b.unpacked} 道已采用的题可以上架</button>
          </Link>
        )}
        {err && <span className="small choice-err">{err}</span>}
      </div>
      {!running && failed > 0 && (
        <ChoiceCard
          question={`有 ${failed} 份素材出错了，怎么办？`}
          reason="出错多半是修订 3 次仍有硬问题，或者模型调用失败（原因见明细）。重做会再花一次模型费；已归型的不重新归型。"
          options={[
            { key: 'all', label: `全部 ${failed} 份重做`, recommended: true },
            { key: 'one', label: '先重做 1 份看看' },
            { key: 'later', label: '先放着' },
            { key: 'other', label: '其他' },
          ]}
          otherHint="写要重做的素材号，如 i003, i007"
          onAnswer={async (key, text) => {
            await postJson('/api/workshop/batch', { action: 'retry', batchId: b.id, option: key, text });
            refresh();
          }}
        />
      )}
      {open && <Items batchId={b.id} tick={tick} />}
    </div>
  );
}

export default function JobsClient({ initial }: { initial: BatchRow[] }) {
  const [rows, setRows] = useState<BatchRow[]>(initial);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => {
    fetch('/api/workshop/status')
      .then((r) => r.json())
      .then((j: { batches?: BatchRow[] }) => {
        if (j.batches) setRows(j.batches);
        setTick((t) => t + 1);
      })
      .catch(() => {});
  }, []);
  const anyRunning = rows.some((r) => r.run?.running);
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [anyRunning, refresh]);

  if (!rows.length) {
    return (
      <div className="card small">
        还没有批次。先到 <Link href="/workshop/ingest">投料</Link> 页投一批聊天记录。
      </div>
    );
  }
  return (
    <div className="ws-grid">
      <div className="small muted">加工在服务器上跑，关掉页面也不会停；服务器重启了，点「继续加工」从断点接着跑，花过钱的步骤不会再花。</div>
      {rows.map((b) => (
        <BatchCard key={b.id} b={b} tick={tick} refresh={refresh} />
      ))}
    </div>
  );
}
