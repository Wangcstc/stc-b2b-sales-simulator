'use client';

import { useState } from 'react';
import Help from '@/components/Help';

/**
 * 标尺校准入口（只有主管看得见）。
 *
 * ★ 这一页解决的问题 ★
 * 标尺（评分锚点）一直写在 lib/llm/score.ts 里，从没跟王老师的判断比对过——
 * 系统每天照它打分，可它准不准，没人量过。原先的校准流程是一份 md 模板，
 * 要手工填表、手工算比例，于是从来没人填。
 *
 * 改成跑一局校一局：填完这张表，两件事同时发生——
 *   ① 对照数据进 ScoreCalibration，Gate 的两个硬数字（差异 ≤1 比例、段位一致率）自己会算；
 *   ② 归因为「锚点问题」的那几条，写成判例进 Calibration 表，
 *      下一局评分时注入 prompt，优先级高于所有通用锚点。
 *
 * ★ 归因这一问不是走过场 ★
 * 「系统引的原话对不对得上记录」——这一问直接把问题分成两类，而两类的修法相反：
 *   对不上 → 取证问题，要修的是引文校验，**动锚点等于用一条错误读数去掰弯一把准尺**；
 *   对得上但判档不同 → 锚点问题，这才该写判例。
 * 所以只有选了「锚点问题」的才会生成判例，其余只计入统计。
 */

export interface ForceRow {
  key: string;
  label: string;
  system: string; // 1–5 / NA / INSUFFICIENT
  anchor: string;
}

type Cause = 'anchor' | 'evidence' | 'facts' | 'not_applicable';

interface Draft {
  human: string;
  cause: Cause | '';
  shouldBe: string;
}

/**
 * ★ 第四类是 2026-08-07 补的 ★
 * 王老师拿 P16 举了个例子：订单都建好了、只差付款的跟进局，系统按「六要素问出 0 项」
 * 把洞察力判到 1 分。可那三类一个都装不下它——系统引的原话没错（不是取证问题），
 * 锚点描述本身也没错（不是锚点问题），他确实没问（事实也是准的）。
 * 它是第四种：**这一力在这一局根本不该考**。
 * 归到这一类的不生成判例——判例改的是"怎么判"，而这里的问题是"不该判"，
 * 要动的是人设的 na_forces 或引擎的适用范围，不是锚点描述。
 */
const CAUSE_LABEL: Record<Cause, string> = {
  evidence: '取证问题——系统引的原话对不上记录',
  anchor: '锚点问题——原话对得上，但判的档次不同',
  facts: '事实表填错——不是标尺的问题',
  not_applicable: '本局不适用——这一力在这一局根本不该考（该记 NA）',
};

export default function CalibrationPanel({
  sessionId,
  forces,
  systemTier,
  saved,
}: {
  sessionId: string;
  forces: ForceRow[];
  systemTier: string | null;
  saved: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [humanTier, setHumanTier] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(saved);

  const get = (k: string): Draft => draft[k] ?? { human: '', cause: '', shouldBe: '' };
  const set = (k: string, patch: Partial<Draft>) => setDraft((d) => ({ ...d, [k]: { ...get(k), ...patch } }));

  /** 差异只在两边都是数字时才算得出来；NA / INSUFFICIENT 不参与 */
  const diffOf = (sys: string, human: string): number | null => {
    const a = Number(sys);
    const b = Number(human);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.abs(a - b);
  };

  const filled = forces.filter((f) => get(f.key).human !== '');
  const diffs = filled.map((f) => diffOf(f.system, get(f.key).human)).filter((d): d is number => d !== null);
  const within1 = diffs.filter((d) => d <= 1).length;

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/session/${sessionId}/calibrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          humanTier: humanTier || null,
          note: note || null,
          forces: filled.map((f) => ({
            key: f.key,
            label: f.label,
            system: f.system,
            human: get(f.key).human,
            cause: get(f.key).cause || null,
            shouldBe: get(f.key).shouldBe || null,
            anchor: f.anchor,
          })),
        }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? '提交失败');
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '提交失败');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card small" style={{ marginTop: 16, borderColor: 'var(--ok)' }}>
        ✓ 这一局已校准。到 <a href="/replay">标尺调参</a> 看累计的差异比例与段位一致率。
      </div>
    );
  }

  if (!open) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <b>校准这一局的标尺</b>
            <div className="small muted" style={{ marginTop: 4 }}>
              先自己判一遍，再和系统对。你的判断是基准，不是参考。
            </div>
          </div>
          <button className="primary" onClick={() => setOpen(true)}>
            开始校准
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 16px' }}>
        <b>校准这一局的标尺</b>
        <Help topic="report-calibration" />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {forces.map((f) => {
          const d = get(f.key);
          const diff = diffOf(f.system, d.human);
          const needCause = diff !== null && diff >= 2;

          return (
            <div key={f.key} className="calib-row">
              <div className="calib-head">
                <span className="calib-name">{f.label}</span>
                <span className="small muted">
                  系统 <b className="num" style={{ color: 'var(--text)' }}>{f.system}</b>
                </span>
                <select value={d.human} onChange={(e) => set(f.key, { human: e.target.value })} style={{ width: 92 }}>
                  <option value="">我判…</option>
                  {['1', '2', '3', '4', '5', 'NA'].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
                {diff !== null && (
                  <span className="small" style={{ color: diff >= 2 ? 'var(--bad)' : 'var(--ok)' }}>
                    差 {diff}
                  </span>
                )}
              </div>

              {f.anchor && <div className="tiny faint calib-anchor">系统命中的锚点：{f.anchor}</div>}

              {needCause && (
                <div className="calib-cause">
                  <div className="tiny" style={{ color: 'var(--warn)', marginBottom: 6 }}>
                    差了 {diff} 分，先分清是哪一类——两类的修法是相反的：
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {(Object.keys(CAUSE_LABEL) as Cause[]).map((c) => (
                      <label key={c} className="small" style={{ display: 'flex', gap: 7, alignItems: 'flex-start' }}>
                        <input
                          type="radio"
                          name={`cause-${f.key}`}
                          checked={d.cause === c}
                          onChange={() => set(f.key, { cause: c })}
                          style={{ width: 'auto', marginTop: 3 }}
                        />
                        <span>{CAUSE_LABEL[c]}</span>
                      </label>
                    ))}
                  </div>

                  {d.cause === 'anchor' && (
                    <div style={{ marginTop: 8 }}>
                      <label className="tiny faint">这种情形应该怎么判？（会写成判例，下一局评分时优先级高于通用锚点）</label>
                      <textarea
                        rows={2}
                        value={d.shouldBe}
                        onChange={(e) => set(f.key, { shouldBe: e.target.value })}
                        placeholder="例：客户已明确报出竞品价，业务员只回「我们质量更好」而没有拆解构成——这种情况博弈力最高给 2 分"
                      />
                    </div>
                  )}
                  {d.cause === 'evidence' && (
                    <div className="tiny" style={{ color: 'var(--muted)', marginTop: 6 }}>
                      记下了。取证问题要修的是引文校验，<b>不会</b>写成判例——用一条错误读数去掰弯一把准尺，只会越校越偏。
                    </div>
                  )}
                  {d.cause === 'not_applicable' && (
                    <div className="tiny" style={{ color: 'var(--muted)', marginTop: 6 }}>
                      记下了。这一类不写判例——判例改的是「怎么判」，而这里的问题是「不该判」。
                      要动的是这个人设的 <code className="mono">na_forces</code>，或者这一力的适用范围。
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="calib-foot">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="small muted">段位：系统判</span>
          <b>{systemTier ?? '—'}</b>
          <select value={humanTier} onChange={(e) => setHumanTier(e.target.value)} style={{ width: 104 }}>
            <option value="">我判…</option>
            {['D1', 'D2', 'D3', 'D4', 'D5'].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {humanTier && (
            <span className="small" style={{ color: humanTier === systemTier ? 'var(--ok)' : 'var(--bad)' }}>
              {humanTier === systemTier ? '一致' : '不一致'}
            </span>
          )}
        </div>

        <div style={{ marginTop: 12 }}>
          <label className="tiny faint">备注（可留空）</label>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="这一局值得记下来的判断" />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          <span className="small muted">
            已填 <b className="num">{filled.length}</b> / {forces.length} 力
            {diffs.length > 0 && (
              <>
                　差异 ≤1：<b className="num">{within1}</b> / {diffs.length}
              </>
            )}
          </span>
          <button className="primary" onClick={submit} disabled={busy || filled.length === 0}>
            {busy ? '提交中…' : '提交校准'}
          </button>
        </div>

        {err && (
          <div className="small" style={{ color: 'var(--bad)', marginTop: 8 }}>
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
