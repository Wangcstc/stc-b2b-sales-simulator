'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { PackPlan, QuestionRow, VersionRow } from '@/lib/workshop/bank';
import ChoiceCard, { postJson } from '../ChoiceCard';

/**
 * 题库页（需求文档 5.2、第九节）：打包上架、装入 / 切换 / 回滚、上传、导出、停用某道题。
 * 每个动作都是一张选择题卡：切换题库影响全员，导出可能把来源备注带出去，停用考试题可能让全员开不了考。
 */

interface Slot {
  label: string;
  questions: number;
  types: number;
  needQuestions: number;
  needTypes: number;
  ready: boolean;
  missingTypes: { code: string; name: string }[];
}
interface PackResult {
  bankId: string;
  bankVersion: string;
  added: number;
  total: number;
  activated: boolean;
  drill: number;
  exam: Slot[];
  skipped?: boolean;
}

function Readiness({ drill, exam }: { drill: number; exam: Slot[] }) {
  const gaps = exam.filter((s) => !s.ready);
  return (
    <div className="small ws-grid" style={{ gap: 4 }}>
      <div>演习：{drill} 道，装进去就能练。以后有新聊天随时投，题越多越不容易撞题。</div>
      {gaps.length ? (
        <>
          <div>考试：还没凑齐（凑齐前开不了考，演习不受影响），差的是：</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {gaps.map((s) => (
              <li key={s.label}>
                {s.label}：
                {[s.questions < s.needQuestions ? `题 ${s.questions}/${s.needQuestions} 道` : '', s.types < s.needTypes ? `题型 ${s.types}/${s.needTypes} 种` : ''].filter(Boolean).join('，')}
                {s.missingTypes.length > 0 && `；还没有的题型：${s.missingTypes.slice(0, 6).map((t) => t.name).join('、')}${s.missingTypes.length > 6 ? ' 等' : ''}`}
              </li>
            ))}
          </ul>
          <div className="muted">碰到这几类买家的聊天，下次优先投进来。每道母题会衍生几道考试题，不用凑很多份。</div>
        </>
      ) : (
        <div>考试：三个槽位都凑齐了，可以开考。</div>
      )}
    </div>
  );
}

function PackSection({ plan, refresh }: { plan: PackPlan; refresh: () => void }) {
  const [result, setResult] = useState<PackResult | null>(null);
  if (result) {
    return (
      <div className="card ws-grid">
        <b>
          ✓ {result.skipped ? '先不打包' : `已打包 ${result.bankId} v${result.bankVersion}：新增 ${result.added} 道，共 ${result.total} 道${result.activated ? '，已切换为当前版本' : '，已装入、还没切换'}`}
        </b>
        {!result.skipped && <Readiness drill={result.drill} exam={result.exam} />}
      </div>
    );
  }
  if (!plan.questions) {
    return (
      <div className="card small">
        没有等上架的题。确认采用的题会出现在这里{plan.busy.length > 0 && `（批次 ${plan.busy.join('、')} 还在加工，停下后再打包）`}。
      </div>
    );
  }
  const cur = plan.current;
  const base = plan.base ? `在当前 ${plan.base.bankId} v${plan.base.bankVersion}（${cur?.counts?.total ?? '?'} 道）上加 ${plan.questions} 道` : cur?.sample ? '当前是样品题库：你们公司的题库从零开始、另起题库号，样品题不混进来' : '这是第一个题库，从零开始';
  const reason = plan.baseMissing
    ? `本机找不到当前版本 ${cur?.bankId} v${cur?.bankVersion} 的题库包文件（不是经题库工坊装入的），打出来的新版本会缺掉现有的题，所以先别切换。到下面「上传题库包」把当前题库包传一次补上存档，再回来打包并切换。`
    : `${plan.batches.map((b) => `${b.id} ${b.questions} 道`).join('、')}。${base}。题库包打出来会先全量校验，不过就不装。`;
  return (
    <ChoiceCard
      question={`把 ${plan.questions} 道已采用的题打包成新版本 v${plan.nextVersion}？`}
      reason={reason}
      options={[
        { key: 'activate', label: '打包，并切换为当前版本', effect: '切换后新开的局用新版本；正在打的局、历史报告不受影响；随时可以切回上一版', recommended: !plan.baseMissing },
        { key: 'load', label: '打包装入，但先不切换', effect: '装进去先放着，回头在下面的版本列表里切换', recommended: plan.baseMissing },
        { key: 'later', label: '先不打包' },
        { key: 'other', label: '其他' },
      ]}
      otherHint="写一个版本号，如 1.2.0（装入但先不切换）"
      onAnswer={async (key, text) => {
        setResult(await postJson<PackResult>('/api/workshop/bank/pack', { option: key, text }));
        refresh();
      }}
    >
      {plan.busy.length > 0 && <div className="small muted">批次 {plan.busy.join('、')} 还在加工，这次不打它们的题。</div>}
    </ChoiceCard>
  );
}

function VersionTable({ versions, refresh }: { versions: VersionRow[]; refresh: () => void }) {
  const [switching, setSwitching] = useState<VersionRow | null>(null);
  const [exporting, setExporting] = useState<VersionRow | null>(null);
  const cur = versions.find((v) => v.isCurrent);
  return (
    <div className="card ws-grid">
      <b>题库版本</b>
      {!versions.length ? (
        <div className="small muted">还没有装过题库。</div>
      ) : (
        <div className="table-wrap">
          <table className="team-table">
            <thead>
              <tr>
                <th>题库</th>
                <th>版本</th>
                <th className="num-col">题数（演习 / 考试）</th>
                <th>装入时间</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td className="mono small">
                    {v.bankId}
                    {v.sample && <span className="chip" style={{ marginLeft: 6 }}>样品</span>}
                  </td>
                  <td className="mono">v{v.bankVersion}</td>
                  <td className="num-col small">{v.counts ? `${v.counts.total}（${v.counts.drill} / ${v.counts.admission_exam}）` : '—'}</td>
                  <td className="small">{new Date(v.loadedAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td>{v.isCurrent ? <span className="chip ok">当前</span> : <span className="chip">未启用</span>}</td>
                  <td className="ws-row">
                    {!v.isCurrent && (
                      <button className="ghost" onClick={() => setSwitching(v)}>
                        切换到这个版本
                      </button>
                    )}
                    {v.archived ? (
                      <button className="ghost" onClick={() => setExporting(v)}>
                        导出
                      </button>
                    ) : (
                      <span className="tiny faint" title="不是经题库工坊装入的，本机没留存档；上传一次同一个包就能补上">无存档</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {switching && (
        <ChoiceCard
          question={`把当前题库切换到 ${switching.bankId} v${switching.bankVersion}？`}
          reason={`现在用的是 ${cur ? `${cur.bankId} v${cur.bankVersion}` : '（没有）'}。切换只影响之后新开的局：正在打的局继续用原来的题，历史局和报告照常能打开；随时可以再切回来。`}
          options={[
            { key: 'switch', label: '切换', effect: '新开的局马上用这个版本', recommended: true },
            { key: 'coverage', label: '先不切，看看现在这一版缺什么', effect: '去「覆盖」页对比，回来再决定' },
            { key: 'keep', label: '先不切' },
            { key: 'other', label: '其他' },
          ]}
          otherHint="写下为什么先不切（记进管理留痕）"
          onAnswer={async (key, text) => {
            if (key === 'coverage') {
              window.location.href = '/workshop/coverage';
              return;
            }
            await postJson('/api/workshop/bank/activate', { versionId: switching.id, option: key, text });
            setSwitching(null);
            refresh();
          }}
        />
      )}
      {exporting && (
        <ChoiceCard
          question={`导出 ${exporting.bankId} v${exporting.bankVersion}？`}
          reason="题库包里每道题带着来源备注（素材编号和脱敏后的原话），给自己备份可以留着；交给外部的人之前剥掉更稳妥。"
          options={[
            { key: 'raw', label: '原样导出', effect: '给自己备份、换服务器时用', recommended: true },
            { key: 'strip', label: '剥掉来源备注再导出', effect: '给外部、别的公司用' },
            { key: 'cancel', label: '不导出' },
            { key: 'other', label: '其他' },
          ]}
          otherHint="写下你想怎么导出"
          onAnswer={async (key) => {
            if (key === 'raw' || key === 'strip') window.location.href = `/api/workshop/bank/export?id=${encodeURIComponent(exporting.id)}${key === 'strip' ? '&strip=1' : ''}`;
            setExporting(null);
          }}
        />
      )}
    </div>
  );
}

function UploadSection({ hasCurrent, refresh }: { hasCurrent: boolean; refresh: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [manifest, setManifest] = useState<{ bank_id: string; bank_version: string; counts?: { total: number } } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function pick(list: File[]) {
    setErr(null);
    setDone(null);
    const m = list.find((f) => f.name === 'manifest.json');
    if (!m) {
      setErr('选的目录里没有 manifest.json：请选题库包所在的那个目录（里面有 manifest.json、personas/）');
      return;
    }
    try {
      setManifest(JSON.parse(await m.text()));
      setFiles(list);
    } catch {
      setErr('manifest.json 读不出来');
    }
  }

  return (
    <div className="card ws-grid">
      <b>上传题库包</b>
      <div className="small muted">在本机用题库工坊打好的题库包，或者导出过的题库包（先解压），选它所在的目录上传。本机用命令行装过、没留存档的版本，再传一次同一个包就补上存档。</div>
      <input
        type="file"
        multiple
        // @ts-expect-error 选目录：浏览器都支持，React 的类型里没有
        webkitdirectory=""
        onChange={(e) => pick([...(e.target.files ?? [])])}
      />
      {err && <div className="small choice-err">{err}</div>}
      {done && <div className="small">✓ {done}</div>}
      {manifest && files.length > 0 && !done && (
        <ChoiceCard
          question={`装入题库包 ${manifest.bank_id} v${manifest.bank_version}${manifest.counts ? `（${manifest.counts.total} 道）` : ''}？`}
          reason="装入前会全量校验（结构、校验和、考纲、引用），不过就不装、不动当前版本。同一个版本装过了就只补存档。"
          options={[
            { key: 'activate', label: '装入，并切换为当前版本', recommended: !hasCurrent, effect: '新开的局用它；正在打的局不受影响' },
            { key: 'load', label: '装入，先不切换', recommended: hasCurrent, effect: '回头在版本列表里切换' },
            { key: 'cancel', label: '不装' },
            { key: 'other', label: '其他' },
          ]}
          otherHint="写下你想怎么处理"
          onAnswer={async (key) => {
            if (key === 'cancel' || key === 'other') {
              setFiles([]);
              setManifest(null);
              return;
            }
            const form = new FormData();
            for (const f of files) {
              form.append('files', f);
              form.append('paths', (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
            }
            form.set('activate', key === 'activate' ? '1' : '0');
            const r = await fetch('/api/workshop/bank/load', { method: 'POST', body: form });
            const j = (await r.json()) as { error?: string; status?: string; questions?: number; activated?: boolean };
            if (!r.ok) throw new Error(j.error ?? `上传失败（${r.status}）`);
            setDone(j.status === 'already-loaded' ? '这个版本装过了，已补上存档' : `已装入 ${j.questions} 道${j.activated ? '，已切换为当前版本' : ''}`);
            setFiles([]);
            setManifest(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function QuestionList({ questions, refresh }: { questions: QuestionRow[]; refresh: () => void }) {
  const [q, setQ] = useState('');
  const [target, setTarget] = useState<QuestionRow | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return (k ? questions.filter((x) => `${x.code} ${x.typeName} ${x.buyer} ${x.company}`.toLowerCase().includes(k)) : questions).slice(0, 50);
  }, [q, questions]);
  if (!questions.length) return null;
  return (
    <div className="card ws-grid">
      <b>当前版本的题（{questions.length} 道）</b>
      <div className="small muted">某道题不想再出现在题池里，就停用它；只改当前版本，打过的局照常能打开，随时可以恢复。</div>
      <input className="choice-text" placeholder="按编号、题型、买家搜" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="table-wrap">
        <table className="team-table">
          <tbody>
            {shown.map((x) => (
              <tr key={x.id}>
                <td className="mono small">{x.code}</td>
                <td className="small">{x.typeName}</td>
                <td className="small">{x.pool}</td>
                <td className="small">
                  {x.buyer} · {x.company}
                </td>
                <td>{x.enabled ? <span className="chip ok">在用</span> : <span className="chip">已停用</span>}</td>
                <td>
                  <button
                    className="ghost"
                    onClick={() => {
                      setTarget(x);
                      setWarning(null);
                    }}
                  >
                    {x.enabled ? '停用' : '恢复'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {questions.length > shown.length && <div className="tiny faint">只列前 50 道，用上面的搜索找其余的。</div>}
      {target && (
        <ChoiceCard
          question={warning ? `${warning}。还要停用 ${target.code} 吗？` : `${target.enabled ? '停用' : '恢复'} ${target.code}（${target.typeName}）？`}
          reason={warning ? '停用后开不了考的槽位，要等补够题、或者恢复这道题才能开考。' : target.enabled ? '停用后它不再出现在题池里（只改当前版本）。打过的局、报告照常能打开，随时可以恢复。' : '恢复后它重新出现在题池里。'}
          options={
            warning
              ? [
                  { key: 'keep', label: '先不停用', recommended: true },
                  { key: 'force', label: '照样停用' },
                  { key: 'cancel', label: '换一道题' },
                  { key: 'other', label: '其他' },
                ]
              : [
                  { key: 'go', label: target.enabled ? '停用' : '恢复', recommended: true },
                  { key: 'keep', label: '先不动' },
                  { key: 'cancel', label: '换一道题' },
                  { key: 'other', label: '其他' },
                ]
          }
          otherHint="写下你的想法"
          onAnswer={async (key) => {
            if (key !== 'go' && key !== 'force') {
              setTarget(null);
              setWarning(null);
              return;
            }
            const r = await postJson<{ warning?: string }>('/api/workshop/bank/toggle', { variantId: target.id, enable: !target.enabled, force: key === 'force' });
            if (r.warning) {
              setWarning(r.warning);
              return;
            }
            setTarget(null);
            setWarning(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

export default function BankClient({ versions, plan, questions }: { versions: VersionRow[]; plan: PackPlan | null; questions: QuestionRow[] }) {
  const router = useRouter();
  const refresh = () => router.refresh();
  return (
    <div className="ws-grid">
      {plan && <PackSection plan={plan} refresh={refresh} />}
      <VersionTable versions={versions} refresh={refresh} />
      <UploadSection hasCurrent={versions.some((v) => v.isCurrent)} refresh={refresh} />
      <QuestionList questions={questions} refresh={refresh} />
    </div>
  );
}
