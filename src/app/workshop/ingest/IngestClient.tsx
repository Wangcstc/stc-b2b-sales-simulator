'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MIN_CLIENT_MESSAGES, createRedactor, parseChatHtml, prepareHtml, type RawChat } from '../../../../drawer/browser';
import ChoiceCard, { postJson, type Choice } from '../ChoiceCard';

/**
 * 投料页（需求文档 5.3）。
 *
 * ★ 原始聊天不出这台电脑 ★ 导出件在这里（主管的浏览器里）解析、脱敏，上传的只有脱敏后的素材。
 * 文件名也不传：导出件的文件名常常就是客户的名字，这里一律改成「c001-化名」。
 *
 * ★ 上传前先看一眼 ★ 拖进来立刻出检查结果（几份能用、几份太短、哪份脱敏自检没过），
 * 还能点开看一份脱敏后的样子——放心了再投。
 */

interface Parsed {
  name: string;
  chat: RawChat;
}
interface Checked {
  label: string;
  chat: RawChat;
}
interface Rejected {
  name: string;
  why: string;
}
interface Summary {
  batchId: string;
  chats: number;
  usable: number;
  blocked: number;
  products: number | null;
  productsInherited: boolean;
  company: boolean;
  estimateCny: number;
  pricesConfigured: boolean;
  firstBatch: boolean;
}

const yuan = (n: number) => (n <= 0 ? '0 元' : n < 0.1 ? '不到 0.1 元' : `约 ${n < 10 ? n.toFixed(1) : Math.round(n)} 元`);
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

function Drop({ label, hint, accept, multiple, onFiles, children }: { label: string; hint: string; accept: string; multiple?: boolean; onFiles: (f: File[]) => void; children?: React.ReactNode }) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`ws-drop${over ? ' over' : ''}`}
      onClick={() => ref.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFiles([...e.dataTransfer.files]);
      }}
    >
      <b>{label}</b>
      <div className="small muted">{hint}</div>
      {children}
      <input ref={ref} type="file" accept={accept} multiple={multiple} hidden onChange={(e) => onFiles([...(e.target.files ?? [])])} />
    </div>
  );
}

export default function IngestClient({ maskCount, previous }: { maskCount: number; previous: { batchId: string; count: number; company: boolean } | null }) {
  const [terms, setTerms] = useState<string[]>([]);
  const [extra, setExtra] = useState('');
  const [parsed, setParsed] = useState<Parsed[]>([]);
  const [bad, setBad] = useState<Rejected[]>([]);
  const [products, setProducts] = useState<File | null>(null);
  const [company, setCompany] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [peek, setPeek] = useState(false);

  useEffect(() => {
    fetch('/api/workshop/mask')
      .then((r) => r.json())
      .then((j: { terms?: string[] }) => setTerms(j.terms ?? []))
      .catch(() => setTerms([]));
  }, []);

  async function addChats(files: File[]) {
    const out: Parsed[] = [];
    const rej: Rejected[] = [];
    for (const f of files) {
      if (!/\.html?$/i.test(f.name)) {
        rej.push({ name: f.name, why: '不是聊天导出件（要 .html）' });
        continue;
      }
      // 「_副本」「(1)」是同一份对话导了两遍
      if (/_副本\d*\.html?$/i.test(f.name) || / \(\d+\)\.html?$/i.test(f.name) || parsed.some((p) => p.name === f.name)) {
        rej.push({ name: f.name, why: '重复的导出件' });
        continue;
      }
      try {
        const chat = parseChatHtml(prepareHtml(new Uint8Array(await f.arrayBuffer())), f.name);
        if (!chat.messages.length) rej.push({ name: f.name, why: '读不出对话（不是阿里国际站聊天导出件？）' });
        else out.push({ name: f.name, chat });
      } catch (e) {
        rej.push({ name: f.name, why: `解析失败：${(e as Error).message}` });
      }
    }
    setParsed((p) => [...p, ...out]);
    setBad((b) => [...b, ...rej]);
    setSummary(null);
  }

  const extraTerms = useMemo(
    () =>
      extra
        .split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    [extra],
  );

  /** 整批用同一个脱敏器、按投料顺序跑：同一个客户在不同文件里拿到同一个化名 */
  const checked = useMemo(() => {
    const red = createRedactor({ extraTerms: [...terms, ...extraTerms] });
    const ok: Checked[] = [];
    const short: Rejected[] = [];
    const failed: Rejected[] = [];
    parsed.forEach((p, i) => {
      const r = red.redact(p.chat);
      const client = r.chat.messages.filter((m) => m.side === 'client').length;
      const alias = slug(String(r.chat.header['客户'] ?? '')) || 'chat';
      const label = `c${String(i + 1).padStart(3, '0')}-${alias}`;
      if (r.residue.length) failed.push({ name: p.name, why: `脱敏自检没过（${r.residue[0]}），这份不传` });
      else if (client < MIN_CLIENT_MESSAGES) short.push({ name: p.name, why: `买家只说了 ${client} 句，信息不够出一道题` });
      // 原文件名连同里面的名字、编号一起不要：来源只记「c001-化名」
      else ok.push({ label, chat: { ...r.chat, source: { ...r.chat.source, file: `${label}.html` } } });
    });
    return { ok, short, failed };
  }, [parsed, terms, extraTerms]);

  const noProducts = !products && !previous;

  async function upload() {
    setBusy(true);
    setErr(null);
    try {
      const form = new FormData();
      form.set('materials', JSON.stringify(checked.ok.map((c) => ({ label: c.label, chat: c.chat }))));
      if (products) form.set('products', products);
      if (company) form.set('company', company);
      form.set('extraMask', extraTerms.join(','));
      const r = await fetch('/api/workshop/ingest', { method: 'POST', body: form });
      const j = (await r.json()) as Summary & { error?: string };
      if (!r.ok) throw new Error(j.error ?? `上传失败（${r.status}）`);
      setSummary(j);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function startCard(s: Summary): { options: Choice[]; reason: string } {
    const per = s.usable ? s.estimateCny / s.usable : 0;
    const price = s.pricesConfigured ? '' : '（没配模型单价，算不出钱，只能按份数估）';
    const recFive = s.firstBatch && s.usable > 5;
    const options: Choice[] = [
      { key: 'all', label: `全部 ${s.usable} 份开始加工`, effect: s.pricesConfigured ? `预计${yuan(s.estimateCny)}（空闲时段单价；工作日 9–12、14–18 点约翻倍）` : '没配单价，花费算不出来', recommended: !recFive },
      { key: 'five', label: '先加工 5 份看看效果', effect: s.pricesConfigured ? `约${yuan(per * Math.min(5, s.usable))}；看完题再决定剩下的` : '看完题再决定剩下的', recommended: recFive },
      { key: 'save', label: '先不加工，只保存', effect: '以后在「加工」页随时开工' },
      { key: 'other', label: '其他' },
    ];
    const reason = recFive
      ? `这是第一批。先做 5 份，看看题目像不像你们真实的买家，再放开剩下的 ${s.usable - 5} 份。${price}`
      : `${s.usable} 份都能用${s.pricesConfigured ? `，预计${yuan(s.estimateCny)}` : ''}。${price}`;
    return { options, reason };
  }

  if (done && summary) {
    return (
      <div className="card ws-grid">
        <b>✓ {done}</b>
        <div className="small">
          批次 <span className="mono">{summary.batchId}</span>。
          {done.startsWith('先不加工')
            ? '素材已经存好，没有开工、没有花钱；想开工时到「加工」页点一下。'
            : '加工在服务器上跑，这个页面可以关掉；进度在「加工」页，出了题会到「确认」页等你。'}
          {summary.blocked > 0 && ` 有 ${summary.blocked} 份的脱敏要你先在「确认」页看一眼。`}
        </div>
        <div className="ws-row">
          <Link href="/workshop/jobs">
            <button className="primary">去看加工进度</button>
          </Link>
          <button
            className="ghost"
            onClick={() => {
              setParsed([]);
              setBad([]);
              setProducts(null);
              setCompany(null);
              setSummary(null);
              setDone(null);
            }}
          >
            再投一批
          </button>
        </div>
      </div>
    );
  }

  const sample = checked.ok[0];

  return (
    <div className="ws-grid">
      <div className="card ws-grid">
        <div className="ws-row" style={{ justifyContent: 'space-between' }}>
          <b>投递素材</b>
          <span className="ws-row small">
            <a href="/api/workshop/template?kind=product">下载产品表模板</a>
            <a href="/api/workshop/template?kind=company">下载公司信息模板</a>
            <a href="/api/workshop/template?kind=guide">填写说明</a>
          </span>
        </div>
        <Drop label="① 聊天记录（必填）" hint="把阿里国际站导出的聊天记录 HTML 拖到这里，可以一次拖很多份。投多少都行，越多越不容易撞题。" accept=".html,.htm" multiple onFiles={addChats}>
          {parsed.length > 0 && <div className="small" style={{ marginTop: 6 }}>已选 {parsed.length} 份</div>}
        </Drop>
        <div className="ws-row" style={{ alignItems: 'stretch' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <Drop label="② 产品表（建议）" hint={previous ? `不交就沿用上一批的（${previous.count} 个产品）` : '拖入填好的产品表模板。价格是 AI 买家判断报价的标准答案'} accept=".xlsx" onFiles={(f) => setProducts(f[0] ?? null)}>
              {products && <div className="small" style={{ marginTop: 6 }}>✓ {products.name}</div>}
            </Drop>
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <Drop label="③ 公司信息（建议）" hint="拖入填好的公司信息模板（不填公司真实名称）" accept=".xlsx" onFiles={(f) => setCompany(f[0] ?? null)}>
              {company && <div className="small" style={{ marginTop: 6 }}>✓ {company.name}</div>}
            </Drop>
          </div>
        </div>
        <div className="small">
          <div className="muted">
            脱敏在你这台电脑的浏览器里完成，服务器只收到脱敏后的内容。客户的名字、公司、邮箱、电话、网址、地址、单号自动抹掉；
            本机脱敏词表 {maskCount} 个词已自动带上。
          </div>
          <label className="small" style={{ display: 'block', marginTop: 6 }}>
            这批还要额外抹掉的词（自家公司名、品牌、业务员的英文名和小名、工厂所在城市，逗号隔开）：
            <input className="choice-text" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="例如：北峰户外, Northpeak, 小周" />
          </label>
        </div>
      </div>

      {(parsed.length > 0 || bad.length > 0) && (
        <div className="card ws-grid">
          <b>检查结果</b>
          <div>
            收到 {parsed.length + bad.length} 份，能用 <b>{checked.ok.length}</b> 份
            {checked.short.length > 0 && `，${checked.short.length} 份太短已跳过`}
            {checked.failed.length + bad.length > 0 && `，${checked.failed.length + bad.length} 份没收`}。
          </div>
          {[...checked.short, ...checked.failed, ...bad].length > 0 && (
            <details className="small">
              <summary>查看原因</summary>
              <ul>
                {[...checked.short, ...checked.failed, ...bad].map((r) => (
                  <li key={r.name + r.why}>
                    <span className="mono">{r.name}</span>：{r.why}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {sample && (
            <details className="small" open={peek} onToggle={(e) => setPeek((e.target as HTMLDetailsElement).open)}>
              <summary>看一眼脱敏后的样子（第一份，只在你的浏览器里）</summary>
              <div className="ws-quote mono">
                {[`客户：${sample.chat.header['客户'] ?? ''}　地区：${sample.chat.header['地区'] ?? ''}`, ...sample.chat.messages.slice(0, 8).map((m) => `${m.side === 'me' ? '我方' : '买家'}：${m.text}`)].join('\n')}
              </div>
            </details>
          )}
          {noProducts && <div className="small choice-err">还没有产品表，也没有上一批可以沿用：先在上面投产品表，不然加工开不了工。</div>}
          {!summary && (
            <div className="ws-row">
              <button className="primary" disabled={busy || !checked.ok.length || noProducts} onClick={upload}>
                {busy ? '上传中…' : `把 ${checked.ok.length} 份脱敏后的素材投进来`}
              </button>
              {err && <span className="small choice-err">{err}</span>}
            </div>
          )}
        </div>
      )}

      {summary && (
        <>
          <div className="card small">
            已收进批次 <span className="mono">{summary.batchId}</span>：聊天 {summary.chats} 份
            {summary.products !== null && `，产品 ${summary.products} 个${summary.productsInherited ? '（沿用上一批）' : ''}`}
            {summary.company ? '，公司信息' : ''}。
            {summary.blocked > 0 && ` 其中 ${summary.blocked} 份有疑似没抹干净的词，会先到「确认」页问你。`}
            考试还差什么，确认采用、打包上架时会按槽位告诉你。
          </div>
          <ChoiceCard
            question="这一批怎么处理？"
            {...startCard(summary)}
            otherHint="写份数（如 10）或预算（如 预算 30）"
            onAnswer={async (key, text) => {
              const r = await postJson<{ say: string }>('/api/workshop/batch', { action: 'start', batchId: summary.batchId, option: key, text });
              setDone(r.say);
            }}
          />
        </>
      )}
    </div>
  );
}
