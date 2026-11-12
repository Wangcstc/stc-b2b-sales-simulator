'use client';

import { useState } from 'react';
import ChatLog, { type LogMsg } from '@/components/ChatLog';
import Help from '@/components/Help';
import PageHelp from '@/components/PageHelp';

interface Qa {
  idx: number;
  question: string;
  answer: string | null;
  followUp: string | null;
  followUpAnswer: string | null;
  skipped: boolean;
}

/**
 * 读响应体，**空 body 或非 JSON 都不许把页面炸掉**。
 *
 * 2026-08-14：/score 抛异常时 Next 回的 500 是空 body，这里原本直接 `await r.json()`，
 * 于是用的人看到的是「在'Response'上执行'json'失败：JSON输入意外结束」——
 * 这句话既不告诉他出了什么事，也不告诉他该怎么办。
 * 现在退回到 HTTP 状态码，至少说清是服务端错了、错在哪一步。
 */
async function readJson(r: Response): Promise<Record<string, unknown>> {
  const text = await r.text();
  if (!text.trim()) {
    return { error: `服务端返回了空响应（HTTP ${r.status}）。请把终端里最后几行发给维护的人——真正的原因在那里。` };
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: `服务端返回的不是 JSON（HTTP ${r.status}）：${text.slice(0, 200)}` };
  }
}

/**
 * 复盘问答界面。
 * ★ 一次只显示一个问题 ★——全列出来，新人会扫一眼挑简单的答、互相参照着编。
 * ★ 2026-08-28 起复盘是可选的 ★ 演习局和考试局都能跳过（王老师裁定：挪出阻塞路径）。
 *   跳过会留痕，报告标「因未作答，以下判断为系统推断」；作答质量本来就不计分。
 */
export default function DebriefClient({
  sessionId,
  initial,
  inquiryText,
  followup,
  messages,
}: {
  sessionId: string;
  initial: Qa[];
  inquiryText: string;
  followup: boolean;
  messages: LogMsg[];
}) {
  const [qa, setQa] = useState<Qa[]>(initial);
  const [cur, setCur] = useState(() => {
    const i = initial.findIndex((q) => !q.answer && !q.skipped);
    return i === -1 ? initial.length : i;
  });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState<string | null>(null);

  const total = qa.length;
  const done = cur >= total;
  const q = qa[cur];

  async function submit() {
    const answer = text.trim();
    if (!answer || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/session/${sessionId}/coach-qa`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idx: cur, answer, isFollowUp: Boolean(followUp) }),
      });
      const data = await readJson(r);
      if (!r.ok) throw new Error(String(data.error ?? '提交失败'));

      setText('');
      if (typeof data.followUp === 'string' && data.followUp) {
        // 追问一次，就一次
        setFollowUp(data.followUp);
      } else {
        setFollowUp(null);
        setQa((prev) => prev.map((x, i) => (i === cur ? { ...x, answer } : x)));
        setCur((c) => c + 1);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function skipAll() {
    if (!confirm('跳过复盘问答？报告照常出，但会标注「因未作答，以下判断为系统推断」。复盘不计分——留着它是因为想清楚当时为什么那么问，比看一份报告有用得多。')) return;
    setBusy(true);
    try {
      await fetch(`/api/session/${sessionId}/coach-qa`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idx: cur, skip: true }),
      });
      await goScore();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  async function goScore() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/session/${sessionId}/score`, { method: 'POST' });
      const data = await readJson(r);
      if (!r.ok) throw new Error(String(data.error ?? '评分失败'));
      window.location.href = `/report/${sessionId}`;
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="debrief-grid">
      {/* ── 左：这一局的聊天记录，只读 ──
          复盘问的是「第 3 轮你为什么…」。原先这一页不给记录，新人只能凭印象答，
          而凭印象编出来的答案没有复盘价值——它考的是当时的判断，不是记性。 */}
      <aside className="debrief-log card chat-scroll">
        <div className="subsection-title" style={{ margin: '0 0 10px' }}>
          这一局的记录
        </div>
        <ChatLog inquiryText={inquiryText} followup={followup} messages={messages} />
      </aside>

      <main className="debrief-main">
      <div className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>复盘 · 第 {Math.min(cur + 1, total)} / {total} 问</span>
        <Help topic="debrief-why" label="为什么要先答完" />
        {/* 注册这一页，上面那个「?」的「看完整说明」才有抽屉可拉；
            带 vars 是因为「N 个问题全部答完」里的 N 只有运行时才知道 */}
        <PageHelp page="report" vars={{ total }} compact />
      </div>
      <div style={{ display: 'flex', gap: 4, margin: '10px 0 24px' }}>
        {qa.map((x, i) => (
          <div
            key={i}
            style={{
              height: 4,
              flex: 1,
              borderRadius: 'var(--r-hair)',
              background: i < cur ? 'var(--ok)' : i === cur ? 'var(--me)' : 'var(--line)',
            }}
          />
        ))}
      </div>

      {!done && q && (
        <>
          <div className="card">
            <div className="small muted" style={{ marginBottom: 6 }}>
              {cur < 3 ? '针对这一局的问题' : '固定问题'}
            </div>
            <div style={{ fontSize: 'var(--fs-lg)', lineHeight: 1.7 }}>{q.question}</div>

            {followUp && (
              <div
                style={{
                  marginTop: 14,
                  paddingTop: 14,
                  borderTop: '1px solid var(--line)',
                  color: 'var(--warn)',
                  fontSize: 'var(--fs-lg)',
                }}
              >
                {followUp}
              </div>
            )}
          </div>

          <textarea
            rows={5}
            style={{ marginTop: 16 }}
            value={text}
            disabled={busy}
            placeholder={followUp ? '再答一次，说真话就行…' : '答完才出下一题。（Ctrl+Enter 提交）'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
            }}
          />

          {/* ★ 2026-08-28：考试局也能跳过了 ★ 这里原来对考试局写死一句「考试模式不可跳过」。
              复盘作答质量早已撇出评分，那道闸拦出来的是「必须做、但做不做不改变任何结果」。
              裁定：改成可选。**别把这段改回条件渲染**——后端的 mode 判断也一起去掉了，
              前端再拦一次只会造出「按钮没有、接口放行」的第二种不一致。 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
            <button onClick={skipAll} disabled={busy} className="small">
              跳过复盘直接看报告
            </button>
            <button className="primary" onClick={submit} disabled={busy || !text.trim()}>
              {busy ? '处理中…' : followUp ? '回答追问' : '下一题'}
            </button>
          </div>

        </>
      )}

      {done && (
        <div className="card" style={{ textAlign: 'center', padding: 32 }}>
          <div style={{ fontSize: 'var(--fs-lg)', marginBottom: 8 }}>5 问 5 答已收齐</div>
          <p className="small muted">现在才轮到系统说话。</p>
          <button className="primary" onClick={goScore} disabled={busy} style={{ marginTop: 12 }}>
            {busy ? '评分中，约 1 分钟…' : '生成报告'}
          </button>
        </div>
      )}

      {err && (
        <div className="card small" style={{ marginTop: 12, borderColor: 'var(--bad)', color: 'var(--bad)' }}>
          {err}
        </div>
      )}
      </main>
    </div>
  );
}
