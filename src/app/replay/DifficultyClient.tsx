'use client';

import { useEffect, useState } from 'react';

/**
 * 难度系数（王老师 2026-08-23 裁定）。
 *
 * ★ 全系统只剩这一个旋钮 ★ 原话：「我没有空去每一局再这样给他们调仓和校准。」
 * 所以「标尺校准」（人机对照打分）与「逐项调」（改单条扣分数值）都下架了，
 * 只留这一个数。
 *
 * 它只调一件事：**跑一局拿到 65 分有多难。**
 * 门槛永远是 65，系数不碰门槛。
 */

interface Row {
  baseline: number;
  final: number;
}

interface Status {
  bounds: { min: number; max: number; step: number; default: number };
  current: number;
  pending: { factor: number; effectiveFrom: string; note: string | null } | null;
  history: { factor: number; effectiveFrom: string; note: string | null; createdAt: string }[];
  passMark: number;
  preview: { factor: number; rawNeededForPass: number; table: Row[] };
  nextEffectiveFrom: string;
}

export default function DifficultyClient() {
  const [status, setStatus] = useState<Status | null>(null);
  const [factor, setFactor] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load(f?: number) {
    try {
      const r = await fetch(`/api/replay/difficulty${f === undefined ? '' : `?factor=${f}`}`);
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setErr(body.error ?? `读取难度系数失败（HTTP ${r.status}）`);
        return;
      }
      const data = (await r.json()) as Status;
      setErr(null);
      setStatus(data);
      if (f === undefined) setFactor(data.current);
    } catch {
      setErr('读取难度系数失败，检查网络或重新登录');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // 拖动时重新拉预览。★ 折算一律由服务端算 ★
  // 前端自己再算一份，迟早和后端对不上——那正是这套系统最忌讳的事。
  useEffect(() => {
    if (factor === null) return;
    void load(factor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factor]);

  if (err) return <div className="small" style={{ color: 'var(--bad)' }}>{err}</div>;
  if (!status || factor === null) return <div className="small muted">读取中…</div>;

  const dirty = factor !== status.current;
  const p = status.preview;
  const need = p.rawNeededForPass;

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/replay/difficulty', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ factor, note: note.trim() || null }),
      });
      const data = (await r.json()) as {
        error?: string;
        factor: number;
        rawNeededForPass: number;
        effectiveFromLabel: string;
      };
      if (!r.ok) {
        setErr(data.error ?? '保存失败');
        return;
      }
      setMsg(
        `已排好：系数 ${data.factor} —— 要打出 ${data.rawNeededForPass} 分的水平才拿得到 ${status!.passMark} 分。${data.effectiveFromLabel}起生效。`,
      );
      setNote('');
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="difficulty-grid">
        {/* ── 左列 ── */}
        <div className="difficulty-col">
          {/* ① 系数调节器 */}
          <div className="card" style={{ background: 'var(--panel-2)', display: 'grid', gap: 12 }}>
            <div className="subsection-title" style={{ margin: 0 }}>系数调节器</div>

            {/* 滑杆两端直接标出量程，不再单写一行「0.6 最容易 ←→ 1.5 最难」 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <b style={{ fontSize: 'var(--fs-2xl)', minWidth: 62 }} className="num">
                {factor.toFixed(1)}
              </b>
              <span className="tiny faint" title="最容易">
                {status.bounds.min.toFixed(1)}
              </span>
              <input
                type="range"
                min={status.bounds.min}
                max={status.bounds.max}
                step={status.bounds.step}
                value={factor}
                onChange={(e) => setFactor(Number(e.target.value))}
                style={{ flex: 1, minWidth: 120 }}
              />
              <span className="tiny faint" title="最难">
                {status.bounds.max.toFixed(1)}
              </span>
            </div>

            {/* ★ 这一句才是主管真正要看的数 ★「系数 1.2」对人没有意义。
                摆在滑杆正下方，跟着拖动实时变；字号压到正文档，别跟上面的 1.0 抢。 */}
            <div className="small" style={{ lineHeight: 1.7 }}>
              业务员要打出{' '}
              <b
                className="num"
                style={{
                  fontSize: 'var(--fs-lg)',
                  color:
                    need === status.passMark ? 'var(--text)' : need > status.passMark ? 'var(--bad)' : 'var(--ok)',
                }}
              >
                {need}
              </b>{' '}
              分的水平，才拿得到 <b className="num">{status.passMark}</b> 分
              {need === status.passMark && <span className="faint">　（1.0 = 现在的标准）</span>}
            </div>

            {(status.pending || dirty) && (
              <div className="tiny" style={{ color: 'var(--warn)' }}>
                {status.pending && (
                  <>
                    已排队：{status.pending.factor.toFixed(1)}（
                    {new Date(status.pending.effectiveFrom).toLocaleDateString('zh-CN')} 起）
                  </>
                )}
                {status.pending && dirty && ' · '}
                {dirty && '还没保存'}
              </div>
            )}
          </div>

          {/* ② 调节理由 */}
          <div className="card" style={{ display: 'grid', gap: 10 }}>
            <div className="subsection-title" style={{ margin: 0 }}>调节理由</div>
            {/* 填写框与保存按钮同一行——这一块只占两行高，不然左列会比右边的折算表高一截 */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="text"
                placeholder="为什么调？留一句，将来好回溯"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                style={{ flex: 1, minWidth: 0 }}
              />
              <button
                className="primary"
                onClick={save}
                disabled={busy || !dirty}
                style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
              >
                {busy ? '保存中…' : `保存，${status.nextEffectiveFrom}起生效`}
              </button>
            </div>
            {msg && <div className="small" style={{ color: 'var(--ok)' }}>{msg}</div>}
          </div>
        </div>

        {/* ── 右列：③ 系数折算表 ──
            和调节器并排，拖滑杆时左边改数、右边同时看得见分数怎么变 */}
        {/* ★ 表格把整张卡吃满 ★ 两列等高时，剩下的高度分摊到各行去，
            而不是在表格底下留一大块空白——那看着像页面没写完。 */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="subsection-title" style={{ margin: 0 }}>系数折算表</div>
          <table className="small" style={{ width: '100%', marginTop: 10, flex: 1 }}>
            <thead>
              <tr className="muted tiny">
                <th style={{ textAlign: 'left', fontWeight: 400 }}>他实际打出的水平</th>
                <th style={{ width: 34 }} />
                <th style={{ textAlign: 'left', fontWeight: 400 }}>报告上显示的局分</th>
              </tr>
            </thead>
            <tbody>
              {p.table.map((r) => {
                const passed = r.final >= status.passMark;
                return (
                  <tr key={r.baseline}>
                    <td className="num">{r.baseline}</td>
                    <td className="muted" style={{ textAlign: 'center' }}>
                      →
                    </td>
                    <td>
                      <b className="num" style={{ color: passed ? 'var(--ok)' : 'var(--muted)' }}>
                        {r.final}
                      </b>
                      {passed && <span className="tiny" style={{ color: 'var(--ok)' }}>　达标</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── 改动历史 ── */}
      {status.history.length > 0 && (
        <details className="small">
          <summary className="muted">改动历史（{status.history.length} 条）</summary>
          <div style={{ display: 'grid', gap: 4, marginTop: 8 }}>
            {status.history.map((h, i) => (
              <div key={i} className="tiny muted">
                {new Date(h.createdAt).toLocaleString('zh-CN')}　→ 系数 {h.factor.toFixed(1)}，
                {new Date(h.effectiveFrom).toLocaleDateString('zh-CN')} 起生效
                {h.note ? `　「${h.note}」` : ''}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
