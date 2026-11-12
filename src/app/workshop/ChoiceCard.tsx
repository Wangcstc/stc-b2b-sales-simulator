'use client';

import { useState } from 'react';

/**
 * 选择题卡（需求文档第八节）：3 个选项 + 「其他」，第一个是推荐项并写明理由。
 * 题库工坊里凡是要主管拍板的事——开工、确认题目、脱敏漏网、预算、打包上架、切换版本——都用这一个组件，
 * 主管从投料到上架全程只回答选择题（阶段 5.6 的门）。
 *
 * 选项里 key 为 `other` 的就是「其他」：选中后出一个输入框，必须写了才能提交。
 */
export interface Choice {
  key: string;
  label: string;
  effect?: string;
  recommended?: boolean;
}

export default function ChoiceCard({
  question,
  reason,
  options,
  otherHint,
  submitLabel = '确定',
  disabled,
  onAnswer,
  children,
}: {
  question: string;
  reason?: string;
  options: Choice[];
  otherHint?: string;
  submitLabel?: string;
  disabled?: boolean;
  onAnswer: (key: string, text?: string) => Promise<void> | void;
  children?: React.ReactNode;
}) {
  const rec = options.find((o) => o.recommended)?.key ?? options[0]?.key ?? '';
  const [pick, setPick] = useState(rec);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const needText = pick === 'other' && !text.trim();

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await onAnswer(pick, pick === 'other' ? text.trim() : undefined);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card choice-card">
      {children}
      <div className="choice-q">{question}</div>
      {reason && <div className="small muted choice-reason">{reason}</div>}
      <div className="choice-opts" role="radiogroup">
        {options.map((o, i) => (
          <label key={o.key} className={`choice-opt${pick === o.key ? ' on' : ''}`}>
            <input type="radio" name={question} checked={pick === o.key} onChange={() => setPick(o.key)} disabled={busy || disabled} />
            <span className="choice-no">{['①', '②', '③', '④', '⑤'][i] ?? '·'}</span>
            <span>
              {o.label}
              {o.recommended && <span className="chip accent choice-rec">推荐</span>}
              {o.effect && <span className="tiny faint choice-effect">{o.effect}</span>}
            </span>
          </label>
        ))}
      </div>
      {pick === 'other' && (
        <textarea className="choice-text" rows={2} placeholder={otherHint ?? '写下你的意见'} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} />
      )}
      <div className="choice-foot">
        <button className="primary" onClick={submit} disabled={busy || disabled || needText}>
          {busy ? '处理中…' : submitLabel}
        </button>
        {err && <span className="small choice-err">{err}</span>}
      </div>
    </div>
  );
}

/** 页面里调接口的小工具：出错就把中文原因抛出来，交给卡片显示 */
export async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `出错了（${r.status}）`);
  return j;
}
