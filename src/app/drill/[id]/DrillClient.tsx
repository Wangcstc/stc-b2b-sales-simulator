'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import BgCheckPanel from './BgCheckPanel';
import { DrillGuide } from '@/components/Guide';
import PageHelp from '@/components/PageHelp';
import Help from '@/components/Help';
import Icon from '@/components/Icon';

interface Msg {
  turn: number;
  role: string;
  content: string;
}

interface Snapshot {
  id: string;
  drillId: string;
  status: string;
  exitReason: string | null;
  state: {
    patience: number;
    trust: number;
    interest: number;
    turn: number;
    stagnantTurns: number;
    /** 补充说明窗口开着——客户被按住了，等业务员再说一句（2026-08-19 反馈 #7） */
    awaitingReply?: { turn: number; action: string; used: number };
  };
  facts: {
    elements: Record<
      string,
      {
        // status 是 2026-08-23 加的三态；老局的 facts JSON 里没有，读的时候要从 collected 推
        status?: 'unasked' | 'asked_no_answer' | 'collected';
        collected: boolean;
        turn?: number;
        source?: string;
        askedTurn?: number;
        askedQuote?: string;
        gotTurn?: number;
        gotQuote?: string;
        vague?: boolean;
      }
    >;
    redlines: string[];
    quotes: {
      total: number;
      tier: string;
      formatCompliant: boolean;
      quantityMismatch: boolean;
      quantityConfirmed?: boolean;
      /** 逐个产品的报价行。2026-08-23 之前的记录没有这一列 */
      lines?: { product: string; unitPrice: number; quantity: number }[];
    }[];
    unlockedCards: { key: string; turn: number }[];
    /** 已真实投递给客户的资料。2026-08-23 之前的局没有这一列 */
    deliverables?: { turn: number; kind: string }[];
  };
  variant: { variantId: string; openCard: Record<string, unknown>; product: Record<string, unknown> };
  hasBgPackage: boolean;
  /** 动作之后还能再说几句客户才回。真源是 engine/rules.ts 的 SUPPLEMENT_TURNS，由接口下发 */
  supplementTurns?: number;
  sessionType: string;
  examMode: boolean;
  /**
   * 轮内提示：上一轮有没有推进。null ＝ 没什么要说的。
   * ★ 考试局永远是 null ★ 服务端就不给，前端不必再判一次。
   */
  nudge?: string | null;
  messages: Msg[];
}

/** 工具条上的小按钮。基础 button 的 9×16 padding 一行排四个太占地方 */
const BTN_SM: React.CSSProperties = {
  padding: '5px 13px',
  fontSize: 'var(--fs-xs)',
  borderRadius: 'var(--r-md)',
  flexShrink: 0,
};

const ELEMENT_LABEL: Record<string, string> = {
  product_attr: '产品属性',
  quantity: '数量',
  customization: '定制需求',
  address: '收货地址/条款',
  delivery_time: '到货时间',
  other: '其他需求',
};

/**
 * ★ 与 `engine/language.ts` 的 CJK 同一套口径 ★
 * 前端不能直接 import 引擎（那会把整个引擎打进客户端包），所以这里抄一份正则。
 * **抄的是正则本身，不是判定逻辑**——真正扣分的判定只在服务端做一次。
 * 这一份只负责"提前提醒"，两边偶尔不一致也只是提示时机差一点，不影响扣分对不对。
 */
const CJK_RE = /[一-鿿㐀-䶿]/;
const hasCJK = (s: string) => CJK_RE.test(s);

/** 结束原因的中文说法。原来直接把 patienceZero / maxTurns 这种代码打在页头上；主动结束时 exitReason 为空，页头就剩一对空括号 */
const EXIT_LABEL: Record<string, string> = {
  patienceZero: '客户耐心耗尽',
  stagnant: '对话停滞',
  maxTurns: '达到轮数上限',
};

export default function DrillClient({ initial, readOnly }: { initial: Snapshot; readOnly?: boolean }) {
  const [snap, setSnap] = useState(initial);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 另一个窗口把这局往前推了。跟普通报错分开显示——它不是故障，不该吓人 */
  const [stale, setStale] = useState<string | null>(null);
  const [showQuote, setShowQuote] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  const [showState, setShowState] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [showBg, setShowBg] = useState(false);
  const [translating, setTranslating] = useState(false);
  /** 翻译前的中文原文。留着才有「撤销」，也让人能对照着改 */
  const [zhSource, setZhSource] = useState<string | null>(null);
  /**
   * 客户消息的中文译文，按气泡编号存（'open' 是开场询盘，'m3' 是第 4 条消息）。
   * 译过的留在这里：收起再展开不用再调模型、不再花钱；译文只是旁注，不进输入框、不发出去。
   */
  const [zh, setZh] = useState<Record<string, { status: 'loading' | 'done' | 'error'; text?: string; error?: string; show: boolean }>>({});
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [snap.messages.length, busy]);

  /**
   * 输入框跟着内容长高。
   * ★ 先归零再读 scrollHeight ★ 不先置 auto，scrollHeight 会一直返回当前高度，
   * 框只会越长越高、删字也缩不回去。
   * 上限 220px（约八行）——再高就该由框内自己滚，不能把对话区一路挤没。
   */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [input]);

  const ended = snap.status === 'ENDED';
  const locked = Boolean(readOnly) || ended;

  async function refresh() {
    const r = await fetch(`/api/session/${snap.id}`, { cache: 'no-store' });
    if (r.ok) setSnap(await r.json());
  }

  /**
   * 409 = 这局已在别处往前走了（同一个人开了两个窗口/两台电脑）。
   * 处理方式：把最新对话同步过来，把话还给输入框，让人自己看着改——
   * ★ 不许自动重发 ★ 客户的话已经变了，原样再发一遍多半是答非所问。
   */
  async function handleStale(body: { currentTurn?: number; code?: string; error?: string }, restore?: string) {
    await refresh();
    /**
     * ★ 409 现在有两种 ★（2026-08-24）除了"另一个窗口先走了一步"，
     * 还有"这一局已经结束了"（离场或已出分，后端 2026-08-24 起也拦）。
     * 两种都得刷新页面，但话不能说成同一句——对着一局已经结束的局说
     * 「继续到第 ? 轮」，人只会更糊涂。
     */
    if (body.code === 'SESSION_ENDED') {
      setStale(body.error ?? '这一局已经结束了，页面已刷新。');
      return;
    }
    if (restore !== undefined) setInput(restore);
    setStale(
      `这局刚才在另一个窗口继续到第 ${body.currentTurn ?? '?'} 轮，已经把最新对话同步过来了。` +
        `你刚才那句还在输入框里，看完客户的新回复再决定要不要发。`,
    );
  }

  /**
   * 中译英。译完把结果放回输入框，**不自动发送**——
   * 让人过一眼再发是这个功能的一半价值，机器译出来的话不该背着人送出去。
   */
  async function translate() {
    const src = input.trim();
    if (!src || translating || busy || locked) return;
    setTranslating(true);
    setErr(null);
    try {
      const r = await fetch(`/api/session/${snap.id}/translate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: src }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? '翻译失败');
      // 原文留着才能撤销。润色（本来就是英文）也留，改坏了能退回去
      setZhSource(src);
      setInput(data.text);
      // 焦点回输入框并把光标放末尾，接着就能改
      requestAnimationFrame(() => {
        const el = boxRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setTranslating(false);
    }
  }

  function undoTranslate() {
    if (zhSource === null) return;
    setInput(zhSource);
    setZhSource(null);
    boxRef.current?.focus();
  }

  /**
   * 客户消息「译成中文」。点一下出译文（放在原文下面，不替换原文），再点收起。
   * 译文只是看懂用的旁注：不进输入框、不发出去、不进评分。
   */
  async function toggleZh(key: string, text: string) {
    const cur = zh[key];
    if (cur?.status === 'loading') return;
    if (cur?.status === 'done') {
      setZh((z) => ({ ...z, [key]: { ...cur, show: !cur.show } }));
      return;
    }
    setZh((z) => ({ ...z, [key]: { status: 'loading', show: true } }));
    try {
      const r = await fetch(`/api/session/${snap.id}/translate-zh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? '翻译失败');
      setZh((z) => ({ ...z, [key]: { status: 'done', text: data.text, show: true } }));
    } catch (e) {
      setZh((z) => ({ ...z, [key]: { status: 'error', error: (e as Error).message, show: true } }));
    }
  }

  /** 这条客户消息要不要给「译成中文」按钮：已经是中文、系统拼的附件记录、一个英文字母都没有的，都不给 */
  const canTranslate = (text: string) => !hasCJK(text) && /[A-Za-z]/.test(text) && !text.startsWith('[Attachment] ');

  async function send() {
    const content = input.trim();
    if (!content || busy || locked) return;

    /**
     * 中文二次确认（红线④）。
     * ★ 只拦一下，不禁止 ★ 王老师定的是"扣分"不是"不许发"——
     * 真有非发不可的场合（比如粘了个中文型号），他确认一下还是能发出去。
     * 但必须让他知道代价，不能等报告出来才发现被扣了分。
     */
    const zhWarn = '这条是中文，客户读不懂，还会碰红线④扣分。先按 Ctrl+K 译成英文？确定要直接发送吗？';
    if (hasCJK(content) && !confirm(zhWarn)) {
      return;
    }

    setBusy(true);
    setErr(null);
    setStale(null);
    setInput('');
    setZhSource(null);
    try {
      const r = await fetch(`/api/session/${snap.id}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content,
          clientMsgId: crypto.randomUUID(),
          expectedTurn: snap.state.turn, // ★ 我看到的是第几轮 ★ 对不上服务端会挡回来
        }),
      });
      const data = await r.json();
      if (r.status === 409) return void (await handleStale(data, content));
      if (!r.ok) throw new Error(data.error ?? '请求失败');
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
      setInput(content);
    } finally {
      setBusy(false);
    }
  }

  async function sendQuote(form: QuoteFormValues) {
    setBusy(true);
    setErr(null);
    setStale(null);
    try {
      const r = await fetch(`/api/session/${snap.id}/quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...form, clientMsgId: crypto.randomUUID(), expectedTurn: snap.state.turn }),
      });
      const data = await r.json();
      if (r.status === 409) {
        setShowQuote(false);
        return void (await handleStale(data));
      }
      if (!r.ok) throw new Error(data.error ?? '请求失败');
      setShowQuote(false);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 投递一份资料（2026-08-19 反馈 #4）。走法与 sendQuote 一模一样：
   * 占一个完整回合、409 走同一条同步路径、成功后整页刷新拿最新事实表。
   */
  async function sendDeliverable(kind: string) {
    setBusy(true);
    setErr(null);
    setStale(null);
    try {
      const r = await fetch(`/api/session/${snap.id}/deliverable`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, clientMsgId: crypto.randomUUID(), expectedTurn: snap.state.turn }),
      });
      const data = await r.json();
      if (r.status === 409) {
        setShowCatalog(false);
        return void (await handleStale(data));
      }
      if (!r.ok) throw new Error(data.error ?? '请求失败');
      setShowCatalog(false);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 「我说完了，让客户回复」——主动关掉补充说明窗口（2026-08-19 反馈 #7）。
   * 不推进轮次、不发消息，只是把被按住的那句客户回复放出来。
   */
  async function resolveReply() {
    setBusy(true);
    setErr(null);
    setStale(null);
    try {
      const r = await fetch(`/api/session/${snap.id}/resolve-reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedTurn: snap.state.turn }),
      });
      const data = await r.json();
      if (r.status === 409) return void (await handleStale(data));
      if (!r.ok) throw new Error(data.error ?? '请求失败');
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 结束本局 → 先做复盘问答，答完才评分。
   * ★ 不许直接跳评分 ★ 这是 v2.0 的灵魂机制：没拿到答案之前不做诊断。
   * 后端 score 接口也有硬闸，前端这里只是不给入口。
   */
  async function endAndDebrief() {
    if (scoring) return;
    setScoring(true);
    setErr(null);
    try {
      const r = await fetch(`/api/session/${snap.id}/coach-qa`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? '生成复盘问题失败');
      window.location.href = `/debrief/${snap.id}`;
    } catch (e) {
      setErr((e as Error).message);
      setScoring(false);
    }
  }

  const open = snap.variant.openCard as Record<string, string>;
  /** 目录发过没有。老局的 facts JSON 里没有 deliverables 这一列，读作"没发过"——那也正是当时的事实 */
  const catalogSent = (snap.facts.deliverables ?? []).some((d) => d.kind === 'catalog');
  /**
   * 补充说明窗口开着没有（2026-08-19 反馈 #7）。
   * ★ 上限由接口下发，前端不抄 ★ 引擎不能 import 进客户端包，
   * 而"还能再说 N 句"必须跟 `engine/rules.ts` 的 SUPPLEMENT_TURNS 一致——
   * 抄一份的话改了配置界面就开始说假话，而且不会有任何东西报错。
   */
  const waiting = Boolean(snap.state.awaitingReply) && !ended;
  const waitingLeft = Math.max(1, (snap.supplementTurns ?? 1) - (snap.state.awaitingReply?.used ?? 0));
  const waitingActionLabel = snap.state.awaitingReply?.action === 'quote' ? '报价' : '产品目录';

  /** 产品属性收到没有。与下方六要素清单同一套推法（老数据没有 status 列，从 collected 推） */
  const productAttrCollected =
    (snap.facts.elements.product_attr?.status ??
      (snap.facts.elements.product_attr?.collected ? 'collected' : 'unasked')) === 'collected';

  /**
   * ★ 与首页同宽同边界 ★
   * 跑局页原先是通栏铺满的，和首页并排看两条左边界对不上，像两个系统。
   * 这里对齐 .container 的 max-width: var(--page)（1200）与 28px 左右内边距；
   * 上下只留 16——这一页是满屏应用，上下不需要首页那么厚的留白。
   */
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) 340px',
        gap: 16,
        height: '100vh',
        padding: '16px 28px 22px',
        maxWidth: 'var(--page)',
        margin: '0 auto',
      }}
    >
      {/* ───── 左：对话 ─────
          ★ minHeight: 0 不能省 ★ grid／flex 子项默认 min-height: auto，
          意思是"我不会小于我的内容"。少了这一行，这个 section 会被整段对话撑破
          外层的 100vh，于是滚动的是整个页面而不是对话区——
          对话区的 overflow-y 永远触发不了，滚动条自然也就不会出现，
          输入框还会被顶到视口外面去。三个毛病同一个根。 */}
      <section style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <header className="card" style={{ padding: '10px 14px', marginBottom: 12, flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              {/* ★ 中途退出不会丢局 ★ 局存在库里，首页那颗「继续未聊完的局」还找得回来，
                  所以这里给的是一个平静的返回，不做二次确认——确认框会让人以为退出有代价。 */}
              <Link href="/" className="drill-back" title="返回模拟询盘">
                ← 返回
              </Link>
              <div className="mono small">{snap.drillId}</div>
            </div>
            <div className="small muted">
              {snap.sessionType === 'FOLLOWUP' ? '跟进局' : '探需局'} · 第 {snap.state.turn} / 20 轮
              {ended && <b style={{ color: 'var(--bad)', marginLeft: 10 }}>本局已结束（{EXIT_LABEL[snap.exitReason ?? ''] ?? '主动结束'}）</b>}
            </div>
          </div>
        </header>

        {/* ★ 开局指引摆在对话区外面 ★ 放进 chat-scroll 里会跟着对话一起滚走，
            而新人恰恰是打完第一句才发现自己不知道该怎么打第二句。
            只在第 0 轮出现，考试模式不出现——判断在 DrillGuide 里面。 */}
        <DrillGuide examMode={snap.examMode} turn={snap.state.turn} />

        {/* ★ 这一页只注册、不摆按钮 ★（2026-08-27）
            对话页正在计轮次，「这页怎么用」那种按钮摆在这儿是干扰；
            但侧栏里那三个「?」（清单/目录/报价）的「看完整说明」要有抽屉可拉——
            没注册的话它们会退化成 /help 链接，一点就把人从局里带走了。 */}
        <PageHelp page="drill" hidden />

        {/* chat-scroll：只让这一块滚。输入框、按钮条、右侧信息卡都在这个容器外面，不跟着动 */}
        <div
          className="card chat-scroll"
          style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          {/* ★ 跟进局摆的不是询盘，是前情 ★ 标错了新人会当成客户刚说的话
              （首页 page.tsx 早就按局型分了标签，这里过去写死"客户 · 询盘"，口径对不上） */}
          <Bubble
            who="them"
            label={snap.sessionType === 'FOLLOWUP' ? '本局前情' : '客户 · 询盘'}
            zh={canTranslate(String(open.inquiry_text ?? '')) ? { state: zh.open, onToggle: () => toggleZh('open', String(open.inquiry_text ?? '')) } : undefined}
          >
            {String(open.inquiry_text ?? '')}
          </Bubble>

          {/* ★ 跳过 system ★ 第 0 轮那条 system 消息存的就是前情原文，是留给模型读上下文的，
              不是客户说的话。之前没滤掉，它被当成"客户 · 第 0 轮"又画了一遍，
              于是每个跟进局开局都把同一段前情连着显示两次。 */}
          {snap.messages
            .filter((m) => m.role !== 'system')
            .map((m, i) => (
              <Bubble
                key={i}
                who={m.role === 'trainee' ? 'me' : 'them'}
                label={`${m.role === 'trainee' ? '你' : '客户'} · 第 ${m.turn} 轮`}
                zh={m.role !== 'trainee' && canTranslate(m.content) ? { state: zh[`m${i}`], onToggle: () => toggleZh(`m${i}`, m.content) } : undefined}
              >
                {/* ★ 附件消息要看得出是附件 ★（2026-08-19 反馈 #4）
                    这条消息是系统按模板拼的动作记录，不是他打的字。混在普通气泡里，
                    复盘时翻聊天记录根本分不清"他说要发"和"他真发了"——那正是这条反馈的起点。 */}
                {m.content.startsWith('[Attachment] ') ? (
                  <AttachmentBody content={m.content} />
                ) : (
                  m.content
                )}
              </Bubble>
            ))}

          {busy && <div className="muted small">客户输入中…</div>}

          {/* ── 补充说明窗口（2026-08-19 反馈 #7）──
              ★ 必须显式说出来 ★ 客户突然不吭声，业务员第一反应一定是"系统卡了"。
              王铖要的是"给我们再解释清楚的空间"，那这个空间就得看得见、知道还剩多少、
              也知道怎么结束它。少了这块，机制本身反而会被当成故障。 */}
          {/* ★ 轮内提示 ★（2026-08-28，D9 选项 A）
              一局要打完 6–20 轮才拿得到点评，而最该纠正的是第 2、3 轮的问法。
              这里只说状态、不给问法——演习和考试用的是同一批考点，
              练的时候看惯了建议问法，考试时反而更慌。
              ★ 排在等待条前面 ★ 两者不会同时出现（动作那一轮不提示），
              但真撞上时，"客户在等你说话"比"你上一轮没问出东西"更急。 */}
          {!busy && !waiting && snap.nudge && (
            <div
              className="card small"
              style={{ borderColor: 'var(--line-strong)', background: 'var(--panel-2)', lineHeight: 1.8 }}
            >
              <b className="faint">{snap.nudge}</b>
              <div className="tiny faint" style={{ marginTop: 4 }}>
                不是扣分，是提个醒：客户的耐心每轮都在掉，问不出东西的轮次是白花的。
                具体该怎么问，局末的报告会逐轮讲。
              </div>
            </div>
          )}

          {!busy && waiting && (
            <div
              className="card small"
              style={{ borderColor: 'var(--warn)', background: 'var(--panel-2)', lineHeight: 1.8 }}
            >
              <b style={{ color: 'var(--warn)' }}>
                ⏳ 客户还没开口——{waitingActionLabel}发出去了，他在等你把话说完
              </b>
              <div className="tiny faint" style={{ marginTop: 4 }}>
                这是真实谈单的节奏：报价/资料丢过去就闭嘴，等于把解释权交给对方。
                趁现在把价格构成、MOQ、交期、你比别家强在哪讲清楚——你还可以再说{' '}
                <b>{waitingLeft}</b> 句，说完客户才会回。
              </div>
              <button onClick={resolveReply} disabled={busy || locked} style={{ ...BTN_SM, marginTop: 8 }}>
                没什么要补充的，让客户回复
              </button>
            </div>
          )}

          <div ref={endRef} />
        </div>

        {stale && (
          <div className="card small" style={{ marginTop: 8, borderColor: 'var(--warn)', color: 'var(--warn)' }}>
            <span className="with-ico" style={{ alignItems: 'flex-start' }}>
              <Icon name="alert" size={14} style={{ marginTop: 3 }} />
              {stale}
            </span>
          </div>
        )}
        {err && (
          <div className="card small" style={{ marginTop: 8, borderColor: 'var(--bad)', color: 'var(--bad)' }}>
            {err}
          </div>
        )}

        {/* ── 输入框上方工具条 ──
            左边是这一局的动作（报价/背调/复盘/报告），右边是写这句话用的翻译。
            ★ 只有「发送」留在输入框边上 ★ 发送是每句都按的，其余几个一局才按一次，
            混在一根竖排里，最常用的那个反而要在四个按钮里找。

            ★ 译完不自动发 ★ 让人过一眼再发是翻译功能的一半价值。
            机器译的话背着人送出去，出了洋相新人还不知道是谁写的。 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 12,
            minHeight: 30,
            flexWrap: 'wrap',
            flexShrink: 0,
          }}
        >
          <button onClick={() => setShowQuote(true)} disabled={busy || locked} style={BTN_SM}>
            报价
          </button>
          {/* ── 发产品目录（2026-08-19 反馈 #4）──
              ★ 为什么要有这颗按钮 ★ 在它之前，业务员只能在聊天框里打一句
              "I'll send you the catalog"——那对系统而言等于"承诺稍后发"，
              客户于是一轮轮继续要，点评还判他"拖着不给资料"。
              走这颗按钮，动作才真的发生：附件进对话流、进事实表、进客户 prompt。

              ★ 发过之后按钮不禁用，只改文案 ★ 真实业务里补发一次是常事（客户说没收到、
              要换个邮箱）。禁用等于告诉他"这事只能做一次"，那是系统的限制不是业务的规矩。
              事实表那边只记第一次（见 submitDeliverable），重复发不会改判定。 */}
          <button
            onClick={() => setShowCatalog(true)}
            disabled={busy || locked}
            style={BTN_SM}
            title="向客户投递一份产品目录（附件）。客户会真的收到，不会再重复索要——但需求还没问清就先甩目录仍然减分"
          >
            {catalogSent ? '目录已发 · 再发一次' : '发产品目录'}
          </button>
          {snap.hasBgPackage && (
            <button onClick={() => setShowBg(true)} disabled={busy || readOnly} style={BTN_SM}>
              背调
            </button>
          )}
          {/* title 里写「什么时候该点」——新人最常犯的两个错都在收尾：
              聊两三轮就结束（证据不足不给分），或者一路拖到 20 轮（算客户跑了） */}
          <button
            onClick={endAndDebrief}
            disabled={busy || scoring || readOnly}
            style={BTN_SM}
            title="六要素问出 4 项以上、该报的价报了，就可以收了。太早结束会因证据不足不给分，拖满 20 轮算客户已选别家"
          >
            {scoring ? '出题中…' : '结束并复盘'}
          </button>
          {/* 局结束后还要看报告，所以它不跟着 locked 禁用 */}
          <a href={`/report/${snap.id}`} className="small muted" style={{ padding: '0 4px' }}>
            看报告
          </a>

          <div style={{ flex: 1, minWidth: 12 }} />

          {!locked &&
            (zhSource !== null ? (
              <>
                <span className="tiny" style={{ color: 'var(--ok)', flexShrink: 0 }}>
                  ✓ 已改写
                </span>
                <span
                  className="tiny faint"
                  style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={zhSource}
                >
                  原文：{zhSource}
                </span>
                <button className="ghost" onClick={undoTranslate} disabled={busy} style={BTN_SM}>
                  撤销
                </button>
              </>
            ) : (
              <button
                onClick={translate}
                disabled={!input.trim() || translating || busy}
                style={BTN_SM}
              >
                {translating ? '翻译中…' : '译成商务英语'}
                {!translating && <span className="faint" style={{ marginLeft: 7 }}>Ctrl+K</span>}
              </button>
            ))}
        </div>

        {/* ★ 中文预警 ★（红线④，2026-08-23 王老师定）
            课堂原话：「有一点不能用中文回答。这里有翻译功能，你必须先写中文，
            可以先翻译过来再发出去。」
            这里只提示不硬拦——王老师说的是"扣分"，不是"禁止发送"。
            真发出去了，客户会回一句读不懂，这一轮就白费了。 */}
        {!readOnly && !ended && hasCJK(input) && (
          <div
            className="small"
            style={{
              marginTop: 8,
              padding: '6px 10px',
              borderRadius: 'var(--r-sm)',
              border: '1px solid var(--warn)',
              color: 'var(--warn)',
              lineHeight: 1.6,
            }}
          >
            检测到中文 · <b>Ctrl+K</b> 译成英文再发。直接发出去会碰<b>红线④</b>，
            而且客户是海外买家，他一个字都读不懂——这一轮会白白浪费掉。
          </div>
        )}

        {/* ★ 按钮贴底不拉伸 ★ 输入框会随内容长到 220px，
            用 stretch 的话「发送」会跟着长成一根两百多像素的立柱 */}
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'flex-end', flexShrink: 0 }}>
          <textarea
            ref={boxRef}
            rows={3}
            className="chat-scroll"
            style={{ flex: 1, minWidth: 0, resize: 'none', maxHeight: 220, overflowY: 'auto' }}
            value={input}
            disabled={busy || locked || translating}
            placeholder={
              readOnly
                ? '这是别人的局，你只能看'
                : ended
                  ? '本局已结束'
                  : busy
                    ? '等客户回复中，输入框已锁'
                    : translating
                      ? '翻译中…'
                      : '可以先写中文，Ctrl+K 译成商务英语再发（Ctrl+Enter 发送）'
            }
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
              // Ctrl+T 会被浏览器抢去开新标签页，所以用 Ctrl+K
              if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                translate();
              }
            }}
          />
          <button
            className="primary"
            onClick={send}
            disabled={busy || locked || !input.trim()}
            style={{ minWidth: 92, flexShrink: 0 }}
          >
            发送
          </button>
        </div>
      </section>

      {/* ───── 右：侧栏资料 ───── */}
      <aside
        className="chat-scroll"
        style={{ overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div className="card">
          <b className="small">客户信息</b>
          <table className="small" style={{ width: '100%', marginTop: 8, borderSpacing: 0 }}>
            <tbody>
              {/* ★ 平台行为数据要摆出来 ★ 它不是装饰，是第一课 7.1「平台数据的读法」要考的东西。
                  P2 那种客户就靠这个判断：询盘只有一句话，可浏览 1259 次、登录 71 天——
                  只看询盘会当成垃圾客户，看行为数据才知道是十年老买家。
                  没有的字段整行不显示，老人设不受影响。 */}
              {(
                [
                  ['姓名', open.name],
                  ['国家', open.country],
                  ['公司', open.company],
                  ['买家等级', open.buyer_level],
                  ['近90天登录', open.login_days_90d != null ? `${open.login_days_90d} 天` : ''],
                  ['近90天浏览', open.product_views_90d != null ? `${open.product_views_90d} 次` : ''],
                  ['近90天有效询盘', open.valid_inquiries_90d != null ? String(open.valid_inquiries_90d) : ''],
                  ['标签', Array.isArray(open.tags) ? (open.tags as unknown as string[]).join('/') : ''],
                  ['邮箱', open.email],
                ] as [string, string][]
              )
                .filter(([, v]) => v !== '' && v != null)
                .map(([k, v]) => (
                  <tr key={k}>
                    <td className="muted" style={{ padding: '2px 8px 2px 0', whiteSpace: 'nowrap' }}>
                      {k}
                    </td>
                    <td>{v}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <ProductCard product={snap.variant.product} />

        {/* ★ 考试模式隐藏六要素清单 ★ 否则考的是抄清单，不是内化（需求 11.1） */}
        {snap.examMode ? (
          <div className="card small muted">
            考试模式：六要素清单已隐藏。侧栏只保留产品参数与报价格式规则。
          </div>
        ) : (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <b className="small">六要素清单</b>
            <Help topic="drill-checklist" narrow />
          </div>
          {/* ★ 图例常驻，不做成看一次就消失的提示 ★
              △ 和 ✓ 的区别是这块面板的全部信息量所在，而新人每一局都会忘：
              客户主动吐出来的要素不算你的功劳，报告里会分开写成两行。 */}
          <div className="tiny faint" style={{ marginBottom: 8, lineHeight: 1.6 }}>
            <span style={{ color: 'var(--ok)' }}>✓</span> 你问出来的
            <span style={{ color: 'var(--warn)' }}>△</span> 客户主动给的（不算你的功劳）
            <br />
            <span style={{ color: 'var(--bad)' }}>◑</span> 你问了，客户还没给（去追）　□ 还没问
          </div>
          {Object.entries(ELEMENT_LABEL).map(([k, label]) => {
            const e = snap.facts.elements[k];
            // 老数据没有 status 列，从 collected 推——与 engine/types.ts 的 statusOf 同口径
            const st: string = e?.status ?? (e?.collected ? 'collected' : 'unasked');
            const volunteered = e?.source === 'volunteered';
            const mark = st === 'collected' ? (volunteered ? '△' : '✓') : st === 'asked_no_answer' ? '◑' : '□';
            const color =
              st === 'collected'
                ? volunteered
                  ? 'var(--warn)'
                  : 'var(--ok)'
                : st === 'asked_no_answer'
                  ? 'var(--bad)'
                  : 'var(--muted)';
            // ★ 判定依据要能复核 ★ 2026-08-19 业务员反馈"它凭什么说我没问"——
            // 光给一个勾没法申诉，得把是第几轮、哪句话摆出来。
            const why =
              st === 'collected'
                ? e?.gotQuote
                  ? `客户第${e?.gotTurn ?? e?.turn}轮说：${e.gotQuote}`
                  : `第${e?.turn}轮拿到`
                : st === 'asked_no_answer'
                  ? e?.askedQuote
                    ? `你第${e?.askedTurn}轮问过：${e.askedQuote}${e?.vague ? '（客户只给了模糊回答）' : '（客户没答）'}`
                    : `你第${e?.askedTurn}轮问过，客户还没给`
                  : '';
            return (
              <div
                key={k}
                className="small"
                style={{ display: 'flex', justifyContent: 'space-between' }}
                title={why}
              >
                <span style={{ color }}>
                  {mark} {label}
                </span>
                <span className="muted">
                  {st === 'collected'
                    ? `第${e?.gotTurn ?? e?.turn}轮${volunteered ? '（客户主动给）' : ''}`
                    : st === 'asked_no_answer'
                      ? e?.vague
                        ? '答得含糊'
                        : '问了没答'
                      : ''}
                </span>
              </div>
            );
          })}
        </div>
        )}

        {snap.facts.redlines.length > 0 && (
          <div className="card" style={{ borderColor: 'var(--bad)' }}>
            <b className="small" style={{ color: 'var(--bad)' }}>已触发红线</b>
            <div className="small">{snap.facts.redlines.join('、')}</div>
          </div>
        )}

        {snap.facts.quotes.length > 0 && (
          <div className="card">
            <b className="small">报价记录</b>
            {snap.facts.quotes.map((q, i) => (
              <div key={i} className="small" style={{ marginTop: 4 }}>
                {/* ★ 多产品逐行摆出来（2026-08-19 反馈 #6）★ 只显示一个合计的话，
                    业务员没法当场核对第二个产品填对没有 */}
                {(q.lines ?? []).length > 1 && (
                  <div className="tiny faint" style={{ marginBottom: 2 }}>
                    {(q.lines ?? []).map((l, n) => (
                      <div key={n}>
                        {l.product || '（未写产品名）'} USD {l.unitPrice} × {l.quantity}
                      </div>
                    ))}
                  </div>
                )}
                USD {q.total.toFixed(2)} · {q.tier} 档 · 格式
                <span style={{ color: q.formatCompliant ? 'var(--ok)' : 'var(--bad)' }}>
                  {q.formatCompliant ? '合规' : '不合规'}
                </span>
                {/* ★ 别再吐一行没头没脑的红字 ★ 2026-08-19 业务员把"数据失真"读成了系统报错。
                    它其实是数量陷阱命中了。局中不能说破真实数量（那是暗牌），
                    但至少要说清"你这个数没确认过"，让人知道该往哪追。 */}
                {q.quantityMismatch && (
                  <span
                    style={{ color: 'var(--bad)' }}
                    title={
                      q.quantityConfirmed === false
                        ? '你报价时数量还没被客户确认过。他口头提的数字不等于真实采购量——去追问确认。'
                        : '客户给过数量，但你面板里填的对不上。'
                    }
                  >
                    {' · '}
                    {q.quantityConfirmed === false ? '数量未确认就报了' : '填的数量与客户给的不符'}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="card">
          <button className="small" style={{ width: '100%' }} onClick={() => setShowState((v) => !v)}>
            {showState ? '隐藏' : '显示'}状态板（跑局时建议别看）
          </button>
          {showState && (
            <div className="small mono" style={{ marginTop: 8 }}>
              <div>patience {snap.state.patience}</div>
              <div>trust {snap.state.trust}</div>
              <div>interest {snap.state.interest}</div>
              <div>连续无新信息 {snap.state.stagnantTurns} 轮</div>
              <div style={{ marginTop: 6 }}>
                已解锁：{snap.facts.unlockedCards.map((c) => `${c.key}(第${c.turn}轮)`).join('、') || '无'}
              </div>
            </div>
          )}
        </div>
      </aside>

      {showQuote && <QuoteModal onClose={() => setShowQuote(false)} onSubmit={sendQuote} busy={busy} />}
      {showCatalog && (
        <CatalogModal
          onClose={() => setShowCatalog(false)}
          onSubmit={() => sendDeliverable('catalog')}
          busy={busy}
          alreadySent={catalogSent}
          /* 需求还没问清就先甩目录会扣 interest（catalogBeforeNeeds）。
             ★ 提醒但不拦 ★ 与红线④ 同一条口径：这是他的判断，系统只负责让他知道代价。 */
          needsUnknown={!productAttrCollected}
        />
      )}
      {showBg && <BgCheckPanel sessionId={snap.id} onClose={() => setShowBg(false)} />}
    </div>
  );
}

type ZhState = { status: 'loading' | 'done' | 'error'; text?: string; error?: string; show: boolean } | undefined;

function Bubble({
  who,
  label,
  children,
  zh,
}: {
  who: 'me' | 'them';
  label: string;
  children: React.ReactNode;
  /** 客户消息才有：译文状态 + 点按钮的回调。没给就没有按钮 */
  zh?: { state: ZhState; onToggle: () => void };
}) {
  const me = who === 'me';
  const st = zh?.state;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start' }}>
      <div className="tiny faint" style={{ marginBottom: 4 }}>{label}</div>
      <div className={me ? 'bubble me' : 'bubble them'}>
        {children}
        {/* 译文放在原文下面，不替换原文：对照着读才学得到客户是怎么说话的 */}
        {st?.show && st.status === 'loading' && <div className="bubble-zh muted small">翻译中…</div>}
        {st?.show && st.status === 'error' && (
          <div className="bubble-zh small" style={{ color: 'var(--bad)' }}>
            {st.error}
          </div>
        )}
        {st?.show && st.status === 'done' && (
          <div className="bubble-zh">
            <div className="tiny faint" style={{ marginBottom: 2 }}>中文译文</div>
            {st.text}
          </div>
        )}
      </div>
      {zh && (
        <button type="button" className="zh-toggle" onClick={zh.onToggle} disabled={st?.status === 'loading'}>
          {st?.status === 'loading' ? '翻译中…' : st?.status === 'done' && st.show ? '收起译文' : st?.status === 'error' ? '重试翻译' : '译成中文'}
        </button>
      )}
    </div>
  );
}

/**
 * 附件消息的样子。三行分工固定（见 session-service 的 formatDeliverableMessage）：
 * 第 1 行文件名、第 2 行给客户看的英文正文、第 3 行给业务员看的中文动作标注。
 *
 * ★ 按行拆而不是按内容猜 ★ 格式是我们自己拼的，行数与顺序确定；
 * 万一将来模板改了、行数对不上，剩下的行原样显示，不会丢内容。
 */
function AttachmentBody({ content }: { content: string }) {
  const [file = '', ...rest] = content.split('\n');
  const note = rest.find((l) => l.startsWith('［'));
  const body = rest.filter((l) => l !== note);
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {/* ★ 自己铺了底色，就得自己定文字色 ★（2026-08-25）
          这个附件条挂在自己那侧的气泡里，气泡是强调色实底、字色继承下来是白的；
          而它自己又铺了一层 --panel-2。深皮下 --panel-2 是深色，白字凑巧能读；
          换到浅皮，--panel-2 成了近白色，文件名就整条消失了。
          规矩：凡是自己设了 background 的元素，必须同时设 color——不能靠继承来的那个。 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderRadius: 'var(--r-md)',
          background: 'var(--panel-2)',
          color: 'var(--text)',
        }}
      >
        <Icon name="paperclip" size={15} />
        <span className="mono tiny">{file.replace('[Attachment] ', '')}</span>
      </div>
      {body.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
      {note && (
        <div className="tiny faint">{note}</div>
      )}
    </div>
  );
}

/** 产品卡读题库格式 v1 的规范化产品字段（见 standards/schema/product.schema.json） */
type Tier = { min_qty?: number | null; max_qty?: number | null; unit_price: number | string; currency?: string; incoterm?: string | null; port?: string | null; variant?: string | null };
const show = (v: unknown) => (Array.isArray(v) ? v.join(' / ') : v && typeof v === 'object' ? JSON.stringify(v) : String(v));

function ProductCard({ product }: { product: Record<string, unknown> }) {
  const attrs = (product.attributes ?? {}) as Record<string, unknown>;
  const tiers = (Array.isArray(product.price_tiers) ? product.price_tiers : []) as Tier[];
  const sur = (product.surcharges ?? {}) as Record<string, unknown>;
  const moq = product.moq as { qty: number | string; unit?: string } | undefined;
  // 同一贸易术语、港口、配置的档位放在一组
  const groups = new Map<string, Tier[]>();
  for (const t of tiers) {
    const key = [t.incoterm, t.port, t.variant].filter(Boolean).join(' ') || '阶梯价';
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return (
    <div className="card">
      <b className="small">
        {String(product.name)}
        {product.model ? `（${String(product.model)}）` : ''}
      </b>
      <div className="small" style={{ marginTop: 6 }}>
        {Object.entries(attrs).map(([k, v]) => (
          <div key={k}>
            <span className="muted">{k}：</span>
            {show(v)}
          </div>
        ))}
        {moq && (
          <div>
            <span className="muted">起订量：</span>
            {String(moq.qty)} {moq.unit ?? ''}
          </div>
        )}
      </div>
      <div className="small" style={{ marginTop: 8 }}>
        {[...groups].map(([label, list]) => (
          <div key={label} style={{ marginTop: 4 }}>
            <span className="muted">{label} 阶梯价</span>
            {list.map((t, i) => (
              <div key={i}>
                {t.min_qty ?? ''}
                {t.max_qty ? `–${t.max_qty}` : '+'} pcs：{t.currency ?? 'USD'} {String(t.unit_price)}
              </div>
            ))}
          </div>
        ))}
        {Object.keys(sur).length > 0 && (
          <div className="muted" style={{ marginTop: 4 }}>
            加价：{Object.entries(sur).map(([k, v]) => `${k} +${show(v)}`).join(' / ')}
          </div>
        )}
      </div>
      <div className="small" style={{ marginTop: 8, color: 'var(--muted)' }}>
        报价格式：&lt;100 可纯文字 ｜ 100–300 至少截图 ｜ &gt;300 报价表+截图
      </div>
    </div>
  );
}

/**
 * 发产品目录的确认框（2026-08-19 反馈 #4）。
 *
 * ★ 为什么要一次确认，而不是点了直接发 ★ 它占一个完整回合——客户会就着这份目录回一句，
 * 轮次也会 +1。跟发一句话一样重，不该比发一句话更容易触发。
 *
 * ★ 需求没问清时提醒但不拦 ★ 与红线④ 同一条口径：王老师定的是"扣分"不是"不许发"。
 * 真实业务里也确实有先发资料再谈的打法，那是他的判断；系统的责任是让他知道代价，
 * 不是替他做决定。
 */
function CatalogModal({
  onClose,
  onSubmit,
  busy,
  alreadySent,
  needsUnknown,
}: {
  onClose: () => void;
  onSubmit: () => void;
  busy: boolean;
  alreadySent: boolean;
  needsUnknown: boolean;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--scrim)',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
      onClick={onClose}
    >
      <div className="card" style={{ width: 460, maxWidth: '100%' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px' }}>
          <b>发送产品目录</b>
          <Help topic="drill-catalog" narrow />
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          <div className="card" style={{ background: 'var(--panel-2)', padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icon name="paperclip" size={20} style={{ color: 'var(--muted)' }} />
              <div style={{ minWidth: 0 }}>
                <div className="mono small">Product_Catalog_2026.pdf</div>
                <div className="tiny faint">演习用占位目录 · 客户端可见为附件</div>
              </div>
            </div>
          </div>

          {alreadySent && (
            <div className="small" style={{ color: 'var(--warn)' }}>
              这一局你已经发过一次目录了。再发一次不会改变判定，但客户会看到你又发了一遍——
              除非他说没收到，否则重复发本身就是一次没必要的打扰。
            </div>
          )}

          {needsUnknown && (
            <div className="small" style={{ color: 'var(--bad)', lineHeight: 1.7 }}>
              <span className="with-ico" style={{ alignItems: 'flex-start' }}>
                <Icon name="alert" size={14} style={{ marginTop: 3 }} />
                你还没问清他要什么产品属性就要发目录了。
              </span>
              <br />
              <span className="faint">
                甩一本目录让客户自己挑，是把你的活推给他——这一轮会扣客户的兴趣值。
                先问清楚他要哪一类，再发对应的那几页，效果完全不同。
              </span>
            </div>
          )}

          <div className="tiny faint">发出去会占一个回合，客户会就着这份目录回你一句。</div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={onClose} disabled={busy}>
              取消
            </button>
            <button className="primary" onClick={onSubmit} disabled={busy}>
              {busy ? '投递中…' : '确认发送'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface QuoteLineValues {
  product: string;
  unitPrice: number;
  quantity: number;
}

interface QuoteFormValues {
  lines: QuoteLineValues[];
  freight: number;
  tradeTerms: string;
  leadTimeDays: number;
  hasQuoteSheet: boolean;
  hasScreenshot: boolean;
}

const EMPTY_LINE: QuoteLineValues = { product: '', unitPrice: 0, quantity: 0 };

/**
 * 报价面板（2026-08-19 反馈 #6 改成多行）。
 *
 * 业务员反馈原话：「我们这一轮谈到两个产品……他报价面板就没办法处理。
 * 我是两个报价，我就按照差不多的一下子给他报过去，他那边因为系统里面没有记录，就不知道。」
 *
 * ★ 档位按整份报价的总额算 ★ 与后端 `submitQuote` 同一口径。
 * 界面上先算一遍是为了让人**填的时候就看见**自己掉进了哪一档、格式够不够，
 * 而不是发出去被扣了分才知道。真正算数的判定在后端，这里错了也不影响判分。
 */
function QuoteModal({
  onClose,
  onSubmit,
  busy,
}: {
  onClose: () => void;
  onSubmit: (v: QuoteFormValues) => void;
  busy: boolean;
}) {
  const [v, setV] = useState<QuoteFormValues>({
    lines: [{ ...EMPTY_LINE }],
    freight: 0,
    tradeTerms: '',
    leadTimeDays: 0,
    hasQuoteSheet: false,
    hasScreenshot: false,
  });

  const multi = v.lines.length > 1;
  const goods = v.lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  const total = goods + v.freight;
  const tier = total < 100 ? 'A（<100）' : total <= 300 ? 'B（100–300）' : 'C（>300）';
  const compliant = total < 100 ? true : total <= 300 ? v.hasScreenshot : v.hasQuoteSheet && v.hasScreenshot;

  const setLine = (i: number, patch: Partial<QuoteLineValues>) =>
    setV({ ...v, lines: v.lines.map((l, n) => (n === i ? { ...l, ...patch } : l)) });

  /** 每行都要有真数；多产品时还要写清产品名（与后端校验同一条口径） */
  const sendable =
    v.lines.length > 0 &&
    v.lines.every((l) => l.unitPrice > 0 && l.quantity > 0) &&
    (!multi || v.lines.every((l) => l.product.trim()));

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--scrim)',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 560, maxWidth: '100%', maxHeight: '88vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px' }}>
          <b>报价面板</b>
          <Help topic="drill-quote" narrow />
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          {/* ── 产品行（2026-08-19 反馈 #6）── */}
          {v.lines.map((l, i) => (
            <div
              key={i}
              className="card"
              style={{ background: 'var(--panel-2)', padding: 10, display: 'grid', gap: 8 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="tiny faint">产品 {i + 1}</span>
                <div style={{ flex: 1 }} />
                {v.lines.length > 1 && (
                  <button
                    className="ghost small"
                    onClick={() => setV({ ...v, lines: v.lines.filter((_, n) => n !== i) })}
                    disabled={busy}
                  >
                    删除
                  </button>
                )}
              </div>
              <div>
                <label>产品名 / 型号{multi ? '' : '（选填）'}</label>
                <input
                  value={l.product}
                  placeholder="VC-200 多功能切菜器"
                  onChange={(e) => setLine(i, { product: e.target.value })}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {/**
                 * ★ 必须是受控输入 ★（2026-08-24 修）
                 * 这几个框原来只有 onChange、没有 value。加了第二行再把第一行删掉时，
                 * React 按下标复用 DOM，**输入框里留着上一行的数字，而 state 已经换成了下一行**——
                 * 界面显示 10/100、实际发出去的是 20/200，小计还按后者算。
                 * 产品名那一格本来就是受控的，于是名字跟着挪、数字不挪，错得更隐蔽。
                 * 0 显示成空串，否则新增一行会摆着两个刺眼的 0。
                 */}
                <div>
                  <label>单价 USD</label>
                  <input
                    type="number"
                    step="0.01"
                    value={l.unitPrice || ''}
                    onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label>数量 pcs</label>
                  <input
                    type="number"
                    value={l.quantity || ''}
                    onChange={(e) => setLine(i, { quantity: Number(e.target.value) })}
                  />
                </div>
              </div>
              {l.unitPrice > 0 && l.quantity > 0 && (
                <div className="tiny faint">小计 USD {(l.unitPrice * l.quantity).toFixed(2)}</div>
              )}
            </div>
          ))}

          <button
            className="ghost small"
            style={{ justifySelf: 'start' }}
            onClick={() => setV({ ...v, lines: [...v.lines, { ...EMPTY_LINE }] })}
            disabled={busy}
          >
            ＋ 再加一个产品
          </button>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label>运费 USD（如适用）</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={v.freight || ''}
                onChange={(e) => setV({ ...v, freight: Math.max(0, Number(e.target.value)) })}
              />
            </div>
            <div>
              <label>交期（天，选填）</label>
              <input
                type="number"
                min="0"
                value={v.leadTimeDays || ''}
                onChange={(e) => setV({ ...v, leadTimeDays: Math.max(0, Number(e.target.value)) })}
              />
            </div>
          </div>
          <div>
            <label>贸易术语（选填）</label>
            <input
              value={v.tradeTerms}
              placeholder="FOB 深圳 / DDP 汉堡"
              onChange={(e) => setV({ ...v, tradeTerms: e.target.value })}
            />
          </div>

          <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text)' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              onChange={(e) => setV({ ...v, hasQuoteSheet: e.target.checked })}
            />
            生成报价表文件
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text)' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              onChange={(e) => setV({ ...v, hasScreenshot: e.target.checked })}
            />
            附报价表截图
          </label>

          <div className="card" style={{ background: 'var(--panel-2)', padding: 10 }}>
            <div>
              {multi && <span className="tiny faint">{v.lines.length} 个产品合计　</span>}
              总额 <b>USD {total.toFixed(2)}</b>　档位 <b>{tier}</b>
            </div>
            <div className="small" style={{ color: compliant ? 'var(--ok)' : 'var(--bad)' }}>
              格式{compliant ? '合规' : '不合规'}
            </div>
            {/* ★ 档位按合计算，这一句得说明白 ★ 两个各 200 的产品会跳到 C 档，
                不写出来的话业务员会以为系统算错了 */}
            {multi && (
              <div className="tiny faint" style={{ marginTop: 4 }}>
                档位按整份报价的合计算——分成几个产品报，客户收到的仍是一张单子。
              </div>
            )}
          </div>

          {multi && v.lines.some((l) => !l.product.trim()) && (
            <div className="small" style={{ color: 'var(--bad)' }}>
              报多个产品时每一行都要写清产品名或型号，否则客户分不出哪个价对应哪个货。
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={onClose} disabled={busy}>
              取消
            </button>
            <button className="primary" onClick={() => onSubmit(v)} disabled={busy || !sendable}>
              发送报价
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
