/**
 * 素材台账：imports/*\/redacted.json → 一张可排序可筛选的 xlsx
 *
 *   npm run ledger -- [--imports imports] [--src "<原始聊天记录根目录>"] [--out imports/_素材台账.xlsx]
 *
 * ★ 这张表回答的唯一问题：299 份记录里，哪几份值得做成人设 ★
 * 逐份读全文再判断是不现实的。台账把每份记录压成一行结构化指标，
 * 排个序就能看出哪些有料、哪些是打个招呼就走的废料。
 *
 * ★ L1 / L2 分层，绝不混在一起 ★（技术方案硬约束③：判定不准的东西不许伪装成客观）
 *   L1 客观计数——消息数、天数、首响、订单卡状态。纯代码数出来的，可以当事实用。
 *   L2 规则初判——失单模式、人设候选分。关键词与阈值凑出来的**猜测**，
 *      每一条都带「命中了哪条规则」和置信度，**必须人眼复核**。表里两块用底色分开。
 * 把 L2 当 L1 用，就是拿一堆正则的猜测去决定新人练什么——这正是这套系统最忌讳的事。
 *
 * ★ 不读正文，只读结构 ★
 * 台账里不出现任何一句聊天原文，也不出现询价单号（那是能反查到真人的标识符），
 * 只标「有/无」。素材本身已脱敏，但台账是要拿出来看、可能会转发的东西，再收一道。
 *
 * ★ 现有人设的覆盖面是运行时读出来的，不是写死的 ★
 * 每次跑都扫一遍当前题库包（BANK_DIR）里题目的 skeleton.tests，拿关键词跟每份素材比对，
 * 标出「这份跟 P4 考的是同一件事」。加了新人设，重跑一次，重复嫌疑自动更新。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/* ══════════════ 品牌令牌══════════════
   字体只有 Inter，文字色只有板岩墨，强调只有泓红，其余只作背景与线。不自行发挥。 */
const T = {
  font: 'Inter',
  ink: 'FF1B2733', // 板岩墨 · 唯一文字色
  red: 'FFD21F3C', // 泓红 · 唯一强调色，占比 ≤10%
  redSoft: 'FFFBE9EC', // 浅泓红底（callout）
  white: 'FFFFFFFF',
  card: 'FFECEFF2', // Card Gray · 分区
  mist: 'FFFBFCFD', // Mist White · 打底
  line: 'FFE0E6EB', // Line Gray · 边框细线
} as const;

/* ══════════════ 类型 ══════════════ */

interface ChatMessage {
  date: string | null;
  side: 'me' | 'client';
  sender: string;
  time: string;
  text: string;
  textCn?: string;
  kind: 'text' | 'file' | 'card' | 'image';
  attachments: string[];
}

interface RawChat {
  source: { file: string; exporterVersion: string | null };
  header: Record<string, string>;
  customer: { fields: Record<string, string>; behavior90d: Record<string, string> } | null;
  okki: Record<string, string> | null;
  profile: Record<string, string> | null;
  buying: { cats: string[]; notes: Record<string, string> } | null;
  order: { hasOrder: boolean; text: string } | null;
  messages: ChatMessage[];
}

interface Redacted {
  digest?: Record<string, unknown>;
  audit?: unknown;
  chat: RawChat;
}

/** 一条规则命中的结果 */
interface Hit {
  tag: string;
  why: string;
  /** 高＝有结构化字段撑着（订单卡）；中＝关键词 + 结构信号；低＝只有关键词 */
  conf: '高' | '中' | '低';
}

interface Row {
  slug: string;
  salesperson: string;
  country: string;
  product: string;
  cats: string;
  // ── L1 ──
  msgs: number;
  clientMsgs: number;
  myMsgs: number;
  clientAvgWords: number;
  turns: number;
  firstDay: string;
  lastDay: string;
  spanDays: number | '';
  firstReplyMin: number | '';
  maxSilenceHr: number | '';
  lastSide: string;
  myLastNoReply: string;
  hasOrderCard: string;
  orderStatus: string;
  orderAmount: number | '';
  iQuoted: string;
  media: number;
  openInfo: number;
  hasInquiryNo: string;
  // ── L2 ──
  modes: string;
  topics: string;
  why: string;
  conf: string;
  score: number;
  scoreWhy: string;
  dupe: string;
}

/* ══════════════ 小工具 ══════════════ */

function parseArgs(argv: string[]) {
  let imports = 'imports';
  let src = '';
  let owners = '';
  let out = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--imports') imports = argv[++i] ?? imports;
    else if (a === '--src') src = argv[++i] ?? src;
    else if (a === '--owners') owners = argv[++i] ?? owners;
    else if (a === '--out') out = argv[++i] ?? out;
  }
  return { imports, src, owners, out: out || join(imports, '_素材台账.xlsx') };
}

/** "2026-06-09 20:40" → ms。拿不准就返回 null，绝不猜一个时间出来 */
function ts(m: ChatMessage): number | null {
  const s = `${m.time}`.trim();
  const full = s.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (full) {
    return Date.UTC(+full[1]!, +full[2]! - 1, +full[3]!, +full[4]!, +full[5]!);
  }
  // 老版本 .time 里只有时分，日期在 .date-divider 上
  const hm = s.match(/^(\d{1,2}):(\d{2})/);
  const d = (m.date ?? '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (hm && d) return Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!, +hm[1]!, +hm[2]!);
  return null;
}

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function has(text: string, re: RegExp): boolean {
  return re.test(text);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/* ══════════════ 关键词表 ══════════════
   ★ 全部只用来做 L2 初判 ★ 命中不等于结论，只等于「值得人去看一眼」。 */

const RE = {
  quote: /\bUSD\b|\bUS\$|\$\s?\d|\bFOB\b|\bEXW\b|\bCIF\b|\bDDP\b|\bquotation\b|\bquote\b|\bPI\b|\bproforma\b|单价|报价|总价/i,
  priceAsk: /\bprice\b|\bcost\b|\bhow much\b|\bbest price\b|\bcheapest\b|多少钱|价格|报个价/i,
  bargain: /too (high|expensive)|expensive|\bdiscount\b|lower.{0,12}price|better price|reduce.{0,12}price|太贵|贵了|便宜|降价/i,
  compete: /other supplier|another supplier|other quotation|competitor|somebody else|别家|其他供应商|比价/i,
  chain: /\bmy boss\b|\bthe boss\b|\bmanager\b|\bmy partner\b|\bmy colleague\b|\bmy team\b|check with|discuss with|approval|\bowner\b|老板|领导|合伙人|同事|商量|审批/i,
  sample: /\bsample\b|\bsamples\b|\bswatch\b|样品|打样/i,
  cert: /\bCE\b|\bFDA\b|\bSASO\b|\bSONCAP\b|\bCOC\b|\bROHS\b|\bLFGB\b|certificat|\btest report\b|认证|检测报告/i,
  logi: /\bfreight\b|shipping cost|\bCIF\b|\bDDP\b|door to door|\bBL\b|\bcustoms\b|clearance|\bcontainer\b|运费|海运|清关|货代/i,
  pay: /\bL\/?C\b|\bT\/?T\b|\bpaypal\b|payment term|\bdeposit\b|\bbalance\b|30%|信用证|定金|尾款|付款方式/i,
  moq: /\bMOQ\b|minimum order|起订量|最小起订/i,
  /** 客户给出了「能据以报价」的信息：数量、柜量、规格、型号、用途 */
  gaveInfo:
    /\d{2,}\s*(pcs|piece|units|sets|ctn|cartons|boxes|kg|tons?)\b|\b(20|40)\s?(gp|hq|ft)\b|\bcontainer\b|\bMOQ\b|\bmodel\b|\bsize\b|\bmaterial\b|\bcapacity\b|\bspec\b|\bdimension\b|\bcolou?r\b|个|件|套|柜|规格|型号|材质|尺寸/i,
  custom: /\bcustom\b|\bOEM\b|\bODM\b|\blogo\b|\bpantone\b|\bprinting\b|定制|logo|印刷|开模/i,
  closedOrder: /订单关闭|已关闭|已取消|交易关闭|Closed|Cancel/i,
  paidOrder: /已付款|已发货|交易成功|待发货|Paid|Shipped/i,
} as const;

/* ══════════════ 从一份素材算出一行 ══════════════ */

function buildRow(slug: string, r: Redacted, salesperson: string, coverage: Coverage[]): Row {
  const chat = r.chat;
  const msgs = chat.messages ?? [];
  const client = msgs.filter((m) => m.side === 'client');
  const me = msgs.filter((m) => m.side === 'me');

  const clientText = client.map((m) => m.text).join('\n');
  const myText = me.map((m) => m.text).join('\n');

  /* ── L1：纯计数，不猜 ── */
  const times = msgs.map(ts);
  const known = times.filter((t): t is number => t !== null);
  const firstT = known.length ? Math.min(...known) : null;
  const lastT = known.length ? Math.max(...known) : null;
  const day = (t: number | null) => (t === null ? '' : new Date(t).toISOString().slice(0, 10));

  // 回合数 = 说话方切换的次数 ÷ 2，向下取整。一来一回算一回合
  let switches = 0;
  for (let i = 1; i < msgs.length; i++) if (msgs[i]!.side !== msgs[i - 1]!.side) switches++;
  const turns = Math.floor(switches / 2);

  // 首响：客户第一条 → 我方第一条。客户先开口才算得出来（询盘局本来就是客户先说）
  let firstReplyMin: number | '' = '';
  const firstClientIdx = msgs.findIndex((m) => m.side === 'client');
  if (firstClientIdx >= 0) {
    const a = ts(msgs[firstClientIdx]!);
    const nextMe = msgs.slice(firstClientIdx).find((m) => m.side === 'me');
    const b = nextMe ? ts(nextMe) : null;
    if (a !== null && b !== null && b >= a) firstReplyMin = Math.round((b - a) / 60000);
  }

  // 最长静默：相邻两条消息的最大间隔
  let maxSilenceHr: number | '' = '';
  {
    let max = 0;
    for (let i = 1; i < msgs.length; i++) {
      const a = ts(msgs[i - 1]!);
      const b = ts(msgs[i]!);
      if (a !== null && b !== null && b > a) max = Math.max(max, b - a);
    }
    if (max > 0) maxSilenceHr = round1(max / 3600000);
  }

  const lastMsg = msgs[msgs.length - 1];
  const lastSide = lastMsg ? (lastMsg.side === 'me' ? '我方' : '客户') : '';

  // 我方最后一句之后客户再没出现过 —— 这是「跟丢了」最硬的结构信号
  const myLastNoReply = lastSide === '我方' && client.length > 0 ? '是' : '否';

  const orderText = chat.order?.text ?? '';
  const hasOrderCard = chat.order ? (chat.order.hasOrder ? '有' : '无订单') : '未导出';
  const orderStatus = chat.order?.hasOrder
    ? has(orderText, RE.paidOrder)
      ? '已付款/已发货'
      : has(orderText, RE.closedOrder)
        ? '订单关闭/取消'
        : '有单·状态待确认'
    : '';
  const amountM = orderText.match(/USD\s*([\d,]+(?:\.\d+)?)/i);
  const orderAmount: number | '' = amountM ? Number(amountM[1]!.replace(/,/g, '')) : '';

  const iQuoted = has(myText, RE.quote) ? '是' : '否';
  const media = msgs.reduce((a, m) => a + (m.attachments?.length ?? 0), 0);
  const openInfo = [chat.customer, chat.profile, chat.buying].filter(Boolean).length;

  // 产品：订单卡最准，其次画像里的采购需求，都没有就留空——不从正文里猜
  let product = '';
  const pm = orderText.match(/产品\s*([^\n]{4,90})/);
  if (pm) product = pm[1]!.trim();
  else if (chat.profile?.['采购需求']) product = String(chat.profile['采购需求']).slice(0, 90);
  const cats = chat.buying?.cats?.join(' / ') ?? '';

  const clientAvgWords = client.length
    ? Math.round(client.reduce((a, m) => a + words(m.text), 0) / client.length)
    : 0;

  const spanDays: number | '' =
    firstT !== null && lastT !== null ? round1((lastT - firstT) / 86400000) : '';

  /* ── L2：规则初判。每条都留下命中理由 ── */
  const hits: Hit[] = [];
  const clientSilentAfterQuote =
    iQuoted === '是' &&
    (() => {
      const qi = msgs.findIndex((m) => m.side === 'me' && has(m.text, RE.quote));
      return qi >= 0 && !msgs.slice(qi + 1).some((m) => m.side === 'client');
    })();

  if (chat.order?.hasOrder && has(orderText, RE.paidOrder))
    hits.push({ tag: '已成交', why: '订单卡状态为已付款/已发货', conf: '高' });
  if (chat.order?.hasOrder && has(orderText, RE.closedOrder))
    hits.push({ tag: '成交后订单关闭', why: '订单卡状态含关闭/取消', conf: '高' });

  // ★ 必须拿到真实时间戳才敢判「秒失联」★ 老导出件时间戳缺失时 spanDays 是空的，
  // 把空当成「没跨天」会把一堆聊了很久的老记录误标成秒失联
  if (client.length <= 2 && typeof spanDays === 'number' && spanDays <= 1)
    hits.push({ tag: '秒失联', why: `客户仅 ${client.length} 条发言且未跨天`, conf: '中' });

  if (clientSilentAfterQuote)
    hits.push({ tag: '报价后沉默', why: '我方发出报价后客户零回复', conf: '中' });

  if (iQuoted === '否' && client.length >= 3 && !chat.order?.hasOrder)
    hits.push({ tag: '未报价即断', why: '客户聊了 3 轮以上但我方全程未出价', conf: '中' });

  if (has(clientText, RE.bargain) && !chat.order?.hasOrder)
    hits.push({ tag: '砍价未果', why: '客户提出价高/要折扣，最终无订单', conf: '中' });

  if (has(clientText, RE.compete))
    hits.push({ tag: '比价中', why: '客户提到别家供应商或已有其他报价', conf: '中' });

  /**
   * ★ 「只问价不给信息」不能只看字数 ★
   * 原来卡 clientAvgWords < 15，结果一场来回六轮、认证物流都谈到的西班牙拉锯局也被打上这个标——
   * 那位客户话短，但每句都在给信息。真正的判据是**问了价，却始终没给出能据以报价的东西**
   * （数量、柜量、规格、型号）。字数只作辅助。
   */
  const gaveInfo = has(clientText, RE.gaveInfo);
  if (has(clientText, RE.priceAsk) && !gaveInfo && clientAvgWords > 0 && !chat.order?.hasOrder) {
    // 聊满 5 轮以上还没给数量规格，可能是真「不给信息」，也可能是他在谈别的（认证、物流、审批）——
    // 这种情况降到低置信，别让一场有内容的拉锯被这条规则定性
    const engaged = client.length >= 5 && clientAvgWords >= 10;
    hits.push({
      tag: '只问价不给信息',
      why: engaged
        ? `问了价且全程未给数量/规格，但客户发言 ${client.length} 条、平均 ${clientAvgWords} 词，像是在谈别的事，置信度下调`
        : `客户问了价，但全程没给数量/规格/型号（平均每条 ${clientAvgWords} 词）`,
      conf: engaged ? '低' : '中',
    });
  }

  if (has(clientText, RE.chain))
    hits.push({ tag: '决策链断裂', why: '客户提到老板/合伙人/需内部商量', conf: '中' });

  if (has(clientText, RE.sample) && !chat.order?.hasOrder)
    hits.push({ tag: '索样后未推进', why: '谈到样品但未产生订单', conf: '低' });

  if (has(clientText, RE.cert))
    hits.push({ tag: '认证合规卡点', why: '客户提到 CE/FDA/SASO 等认证或检测', conf: '低' });

  if (has(clientText, RE.logi))
    hits.push({ tag: '物流卡点', why: '客户提到运费/清关/货代', conf: '低' });

  if (has(clientText, RE.pay))
    hits.push({ tag: '支付条款卡点', why: '客户提到 LC/TT/定金/付款方式', conf: '低' });

  if (has(clientText, RE.custom))
    hits.push({ tag: '定制需求', why: '客户提到 OEM/logo/开模/印刷', conf: '低' });

  // 回合数按「说话方切换 ÷ 2」算，一方连发多条只算一次，真实对话里这个数比直觉小得多。
  // 原来卡 turns>=10，实测一场跨了 55 天、来回 12 条的拉锯只有 5 回合，一条都判不出来。
  if (typeof spanDays === 'number' && spanDays >= 30 && client.length >= 4 && !chat.order?.hasOrder)
    hits.push({
      tag: '长期拉锯未成交',
      why: `跨度 ${spanDays} 天、客户发言 ${client.length} 条仍无订单`,
      conf: '中',
    });

  if (typeof firstReplyMin === 'number' && firstReplyMin > 720)
    hits.push({
      tag: '我方首响过慢',
      why: `客户开口到我方首次回复 ${Math.round(firstReplyMin / 60)} 小时`,
      conf: '高',
    });

  /**
   * ★ 结局与话题必须分开 ★
   * 「已成交／报价后沉默／秒失联」是这一局怎么收场的，同一份记录基本只会是一种；
   * 「定制需求／物流卡点／支付条款」只是聊到过这个话题，一份成交单能同时命中四五条。
   * 混在一列里，成交单会挂着七个标签，看起来像是七种失败——那列就废了。
   */
  const TOPIC_TAGS = new Set([
    '定制需求',
    '物流卡点',
    '支付条款卡点',
    '认证合规卡点',
    '比价中',
    '决策链断裂',
    '索样后未推进',
  ]);
  const outcomeHits = hits.filter((h) => !TOPIC_TAGS.has(h.tag));
  const topicHits = hits.filter((h) => TOPIC_TAGS.has(h.tag));

  const topConf = (['高', '中', '低'] as const).find((k) =>
    outcomeHits.some((h) => h.conf === k),
  ) ?? '';

  /* ── 人设候选分：值不值得做成一局 ── */
  let score = 0;
  const reasons: string[] = [];
  const add = (n: number, r: string) => {
    score += n;
    reasons.push(r);
  };

  if (client.length >= 8) add(28, `客户发言 ${client.length} 条`);
  else if (client.length >= 5) add(20, `客户发言 ${client.length} 条`);
  else if (client.length >= 3) add(10, `客户发言 ${client.length} 条`);

  if (clientAvgWords >= 18) add(18, `客户平均 ${clientAvgWords} 词，话里有料`);
  else if (clientAvgWords >= 10) add(10, `客户平均 ${clientAvgWords} 词`);

  const gameSignals = ['砍价未果', '比价中', '决策链断裂', '定制需求', '认证合规卡点'].filter((t) =>
    hits.some((h) => h.tag === t),
  );
  if (gameSignals.length) add(Math.min(20, gameSignals.length * 8), `博弈点：${gameSignals.join('、')}`);

  if (openInfo >= 2) add(12, `明牌完整（客户面板/画像/采购偏好 ${openInfo} 项）`);
  else if (openInfo === 1) add(6, '明牌部分可用');

  if (typeof spanDays === 'number' && spanDays >= 2 && spanDays <= 60)
    add(10, `跨度 ${spanDays} 天，节奏适合做一局`);

  if (hits.some((h) => h.conf === '高')) add(12, '结局有结构化证据（订单卡/时间戳）');

  if (client.length <= 2 && score > 15) {
    score = 15;
    reasons.push('客户只说了不到 3 句，扮演起来没东西可给——扣到 15 封顶');
  }
  const clientAllMedia =
    client.length > 0 && client.every((m) => m.kind === 'image' || m.kind === 'file');
  if (clientAvgWords === 0 || clientAllMedia) {
    score = 0;
    reasons.length = 0;
    reasons.push('客户侧没有可用文本（全是图片/附件），扮演无从谈起，直接判 0');
  }
  score = Math.max(0, Math.min(100, score));

  /* ── 重复嫌疑：跟现有人设撞不撞考点 ── */
  const dupe = coverage
    .filter((c) => c.keys.some((k) => hits.some((h) => h.tag === k)))
    .map((c) => `${c.code}(${c.name})`)
    .join('、');

  return {
    slug,
    salesperson,
    country: chat.header?.['地区'] ?? '',
    product,
    cats,
    msgs: msgs.length,
    clientMsgs: client.length,
    myMsgs: me.length,
    clientAvgWords,
    turns,
    firstDay: day(firstT),
    lastDay: day(lastT),
    spanDays,
    firstReplyMin,
    maxSilenceHr,
    lastSide,
    myLastNoReply,
    hasOrderCard,
    orderStatus,
    orderAmount,
    iQuoted,
    media,
    openInfo,
    hasInquiryNo: chat.header?.['询价单号'] ? '有' : '无',
    // 空着不如写明「没判出来」——筛选时看得见，也提醒这份得人工看
    modes: outcomeHits.map((h) => h.tag).join('、') || '未判定',
    topics: topicHits.map((h) => h.tag).join('、'),
    why: hits.map((h) => `${h.tag}：${h.why}`).join('；'),
    conf: topConf,
    score,
    scoreWhy: reasons.join('；'),
    dupe,
  };
}

/* ══════════════ 现有题目的覆盖面（运行时读 BANK_DIR/personas）══════════════ */

interface Coverage {
  code: string;
  name: string;
  keys: string[];
}

/** 人设名 / 考点 → 台账里的失单模式标签。只在这里维护一次 */
const NAME_TO_TAG: Array<[RegExp, string[]]> = [
  [/沉默/, ['报价后沉默']],
  [/只给价格|只问价/, ['只问价不给信息']],
  [/决策链/, ['决策链断裂']],
  [/比价|竞品/, ['比价中']],
  [/半定制|定制/, ['定制需求']],
  [/认证|合规/, ['认证合规卡点']],
  [/物流|运费/, ['物流卡点']],
  [/付款|支付/, ['支付条款卡点']],
  [/砍价|压价/, ['砍价未果']],
];

function readCoverage(_root: string): Coverage[] {
  // 现有题目从当前题库包读（环境变量 BANK_DIR）；没配就不比对考点撞车
  const dir = process.env.BANK_DIR ? join(process.env.BANK_DIR, 'personas') : '';
  if (!dir || !existsSync(dir)) return [];
  const out: Coverage[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const p = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
        skeleton?: { code?: string; name?: string; tests?: string };
      };
      const code = p.skeleton?.code;
      const name = p.skeleton?.name ?? '';
      if (!code) continue;
      const hay = `${name} ${p.skeleton?.tests ?? ''}`;
      const keys = NAME_TO_TAG.filter(([re]) => re.test(hay)).flatMap(([, k]) => k);
      if (keys.length && !out.some((o) => o.code === code)) out.push({ code, name, keys });
    } catch {
      /* 坏 JSON 不该让整张台账挂掉，跳过即可 */
    }
  }
  return out;
}

/* ══════════════ 业务员归属：从原始目录结构反查 ══════════════
   redacted.json 只留了文件名，丢了它原来在哪个业务员目录下。
   给 --src 就用目录名反查；不给就退回抬头里的「负责人」（可能已被脱敏替换）。 */
/**
 * `--owners` 走化名版映射表：每行 `化名slug|业务员`。
 *
 * ★ 为什么要有这条路 ★ `--src` 靠原始文件名反查，而原始文件名里带的就是客户真名。
 * 台账要拿给别人看、要发出去，生成它的过程里最好连真名都别经手。
 * 映射表在脱敏那一步顺便按同样的遍历顺序生成，键已经是化名。
 */
function readOwnerFile(file: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!file || !existsSync(file)) return map;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const i = line.indexOf('|');
    if (i > 0) map.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return map;
}

function buildOwnerMap(src: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!src || !existsSync(src)) return map;
  for (const d of readdirSync(src)) {
    const p = join(src, d);
    if (!statSync(p).isDirectory()) continue;
    for (const f of readdirSync(p)) if (f.toLowerCase().endsWith('.html')) map.set(f, d);
  }
  return map;
}

/* ══════════════ 写 xlsx ══════════════ */

interface ColDef {
  key: keyof Row;
  head: string;
  width: number;
  block: 'id' | 'l1' | 'l2';
  numFmt?: string;
}

const COLS: ColDef[] = [
  { key: 'slug', head: '素材编号', width: 24, block: 'id' },
  { key: 'salesperson', head: '业务员', width: 13, block: 'id' },
  { key: 'country', head: '国家/地区', width: 18, block: 'id' },
  { key: 'product', head: '产品（订单卡/画像）', width: 34, block: 'id' },
  { key: 'cats', head: '采购品类', width: 20, block: 'id' },

  { key: 'msgs', head: '消息数', width: 9, block: 'l1' },
  { key: 'clientMsgs', head: '客户发言', width: 10, block: 'l1' },
  { key: 'myMsgs', head: '我方发言', width: 10, block: 'l1' },
  { key: 'clientAvgWords', head: '客户平均词数', width: 13, block: 'l1' },
  { key: 'turns', head: '回合数', width: 9, block: 'l1' },
  { key: 'firstDay', head: '首日', width: 12, block: 'l1' },
  { key: 'lastDay', head: '末日', width: 12, block: 'l1' },
  { key: 'spanDays', head: '跨度(天)', width: 10, block: 'l1', numFmt: '0.0' },
  { key: 'firstReplyMin', head: '我方首响(分)', width: 13, block: 'l1', numFmt: '0' },
  { key: 'maxSilenceHr', head: '最长静默(时)', width: 13, block: 'l1', numFmt: '0.0' },
  { key: 'lastSide', head: '最后发言方', width: 11, block: 'l1' },
  { key: 'myLastNoReply', head: '我方收尾后无回应', width: 16, block: 'l1' },
  { key: 'hasOrderCard', head: '订单卡', width: 11, block: 'l1' },
  { key: 'orderStatus', head: '订单状态', width: 17, block: 'l1' },
  { key: 'orderAmount', head: '订单金额(USD)', width: 14, block: 'l1', numFmt: '#,##0.00;(#,##0.00);-' },
  { key: 'iQuoted', head: '我方是否报过价', width: 14, block: 'l1' },
  { key: 'media', head: '图片/附件数', width: 12, block: 'l1' },
  { key: 'openInfo', head: '明牌完整度(0-3)', width: 15, block: 'l1' },
  { key: 'hasInquiryNo', head: '有询价单号', width: 11, block: 'l1' },

  { key: 'modes', head: '结局判定·机器初判', width: 28, block: 'l2' },
  { key: 'conf', head: '置信度', width: 9, block: 'l2' },
  { key: 'topics', head: '话题标签（低置信·仅线索）', width: 30, block: 'l2' },
  { key: 'why', head: '判定依据（命中的规则）', width: 60, block: 'l2' },
  { key: 'score', head: '人设候选分', width: 11, block: 'l2', numFmt: '0' },
  { key: 'scoreWhy', head: '候选分理由', width: 60, block: 'l2' },
  { key: 'dupe', head: '重复嫌疑（现有局）', width: 26, block: 'l2' },
];

const BLOCK_FILL: Record<ColDef['block'], string> = {
  id: T.ink,
  l1: T.ink,
  l2: T.red, // L2 表头用泓红，一眼看出这一块是猜的不是数的
};

function thin() {
  return { style: 'thin' as const, color: { argb: T.line } };
}

async function write(rows: Row[], out: string, meta: { total: number; src: string }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'stc-b2b-sales-simulator · build-ledger';

  /* ── Sheet 1 台账 ── */
  const ws = wb.addWorksheet('素材台账', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }],
  });

  // 第 1 行：分块说明条
  // ★ 分块条的边界按 COLS 的 block 实际算，别写死列号 ★
  // 加一列忘了改这里，说明条就会盖错块，而且不报错。
  const firstOf = (b: ColDef['block']) => COLS.findIndex((c) => c.block === b) + 1;
  const lastOf = (b: ColDef['block']) => COLS.map((c) => c.block).lastIndexOf(b) + 1;
  ws.mergeCells(1, firstOf('id'), 1, lastOf('id'));
  ws.mergeCells(1, firstOf('l1'), 1, lastOf('l1'));
  ws.mergeCells(1, firstOf('l2'), 1, lastOf('l2'));
  const band = (col: number, text: string, fill: string, fontColor: string) => {
    const c = ws.getCell(1, col);
    c.value = text;
    c.font = { name: T.font, size: 11, bold: true, color: { argb: fontColor } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    c.alignment = { vertical: 'middle', horizontal: 'center' };
  };
  band(firstOf('id'), '素材标识', T.card, T.ink);
  band(firstOf('l1'), 'L1 客观计数 · 纯代码数出来的，可当事实用', T.card, T.ink);
  band(firstOf('l2'), 'L2 规则初判 · 关键词凑出来的猜测，必须人眼复核', T.redSoft, T.ink);
  ws.getRow(1).height = 22;

  // 第 2 行：表头
  const head = ws.getRow(2);
  COLS.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.head;
    cell.font = { name: T.font, size: 10.5, bold: true, color: { argb: T.white } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLOCK_FILL[c.block] } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { top: thin(), left: thin(), bottom: thin(), right: thin() };
    ws.getColumn(i + 1).width = c.width;
  });
  head.height = 30;

  // 数据行
  rows.forEach((r, ri) => {
    const row = ws.getRow(ri + 3);
    COLS.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.value = r[c.key] as string | number;
      cell.font = { name: T.font, size: 10.5, color: { argb: T.ink } };
      /**
       * ★ 数据行一律不换行 ★
       * 「判定依据」「候选分理由」这两列动辄百来字，开了 wrapText，Excel 会把整行撑到十几行高，
       * 一屏看不到三条记录——而这张表存在的意义就是快速扫过去挑候选。
       * 长文本让它横向溢出，要看全的点一下单元格看编辑栏。
       */
      cell.alignment = { vertical: 'top', wrapText: false };
      cell.border = { top: thin(), left: thin(), bottom: thin(), right: thin() };
      if (c.numFmt) cell.numFmt = c.numFmt;
      if (c.block === 'l2')
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: T.mist } };
    });
  });

  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: COLS.length } };

  /* ── Sheet 2 分布统计（用公式，不写死数字）── */
  const st = wb.addWorksheet('分布统计');
  const last = rows.length + 2;
  const colLetter = (key: keyof Row) => {
    const i = COLS.findIndex((c) => c.key === key) + 1;
    return ws.getColumn(i).letter;
  };
  const SCORE = colLetter('score');
  const OWNER = colLetter('salesperson');
  const MODES = colLetter('modes');
  const TOPICS = colLetter('topics');

  const put = (r: number, c: number, v: string | number, bold = false, fmt?: string) => {
    const cell = st.getCell(r, c);
    cell.value = v;
    cell.font = { name: T.font, size: 10.5, bold, color: { argb: bold ? T.white : T.ink } };
    if (bold) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: T.ink } };
    cell.border = { top: thin(), left: thin(), bottom: thin(), right: thin() };
    if (fmt) cell.numFmt = fmt;
  };
  st.getColumn(1).width = 32;
  st.getColumn(2).width = 14;

  put(1, 1, '口径', true);
  put(1, 2, '份数', true);
  /**
   * ★ 公式和算好的值都要写 ★
   * exceljs 只写公式、不写缓存结果，Excel 打开会自己算，但预览器、Numbers 的快速查看、
   * 以及任何按缓存值读文件的工具（pandas / openpyxl data_only）看到的全是空白——
   * 一张打开是空的统计表，没人会信它。所以 result 里放 JS 这边已经数好的同一个数，
   * 公式仍然留着，筛选或改行之后照样能重算。
   */
  const owners = ['Lily Chen', 'Grace Lin', 'Ivy Wu'];
  const stats: Array<[string, string, number]> = [
    ['素材总数', `COUNTA(素材台账!A3:A${last})`, rows.length],
    [
      '候选分 ≥ 70（优先做人设）',
      `COUNTIF(素材台账!${SCORE}3:${SCORE}${last},">=70")`,
      rows.filter((x) => x.score >= 70).length,
    ],
    [
      '候选分 50–69（备选）',
      `COUNTIFS(素材台账!${SCORE}3:${SCORE}${last},">=50",素材台账!${SCORE}3:${SCORE}${last},"<70")`,
      rows.filter((x) => x.score >= 50 && x.score < 70).length,
    ],
    [
      '候选分 < 50（暂不用）',
      `COUNTIF(素材台账!${SCORE}3:${SCORE}${last},"<50")`,
      rows.filter((x) => x.score < 50).length,
    ],
    ...owners.map(
      (o): [string, string, number] => [
        `业务员 ${o}`,
        `COUNTIF(素材台账!${OWNER}3:${OWNER}${last},"${o}")`,
        rows.filter((x) => x.salesperson === o).length,
      ],
    ),
    [
      '业务员未归属',
      `COUNTIF(素材台账!${OWNER}3:${OWNER}${last},"")`,
      rows.filter((x) => !x.salesperson).length,
    ],
  ];
  stats.forEach(([label, f, v], i) => {
    put(i + 2, 1, label);
    const cell = st.getCell(i + 2, 2);
    cell.value = { formula: f, result: v } as ExcelJS.CellFormulaValue;
    cell.font = { name: T.font, size: 10.5, color: { argb: T.ink } };
    cell.border = { top: thin(), left: thin(), bottom: thin(), right: thin() };
  });

  let r = stats.length + 3;
  put(r, 1, '结局判定（高/中置信，基本互斥）', true);
  put(r, 2, '份数', true);
  r++;
  const OUTCOME_TAGS = [
    '已成交',
    '成交后订单关闭',
    '报价后沉默',
    '砍价未果',
    '只问价不给信息',
    '未报价即断',
    '秒失联',
    '长期拉锯未成交',
    '我方首响过慢',
    '未判定',
  ];
  const TOPIC_TAGS_OUT = [
    '比价中',
    '决策链断裂',
    '定制需求',
    '认证合规卡点',
    '物流卡点',
    '支付条款卡点',
    '索样后未推进',
  ];
  const tagRow = (t: string, col: string, pick: (x: Row) => string) => {
    put(r, 1, t);
    const cell = st.getCell(r, 2);
    cell.value = {
      formula: `COUNTIF(素材台账!${col}3:${col}${last},"*${t}*")`,
      result: rows.filter((x) => pick(x).includes(t)).length,
    } as ExcelJS.CellFormulaValue;
    cell.font = { name: T.font, size: 10.5, color: { argb: T.ink } };
    cell.border = { top: thin(), left: thin(), bottom: thin(), right: thin() };
    r++;
  };
  for (const t of OUTCOME_TAGS) tagRow(t, MODES, (x) => x.modes);
  r++;
  put(r, 1, '话题标签（低置信，一份可命中多条）', true);
  put(r, 2, '份数', true);
  r++;
  for (const t of TOPIC_TAGS_OUT) tagRow(t, TOPICS, (x) => x.topics);

  /* ── Sheet 3 口径说明 ── */
  const doc = wb.addWorksheet('口径说明');
  doc.getColumn(1).width = 26;
  doc.getColumn(2).width = 110;
  let dr = 1;
  const line = (k: string, v: string, headline = false) => {
    const a = doc.getCell(dr, 1);
    const b = doc.getCell(dr, 2);
    a.value = k;
    b.value = v;
    a.font = { name: T.font, size: 10.5, bold: true, color: { argb: headline ? T.white : T.ink } };
    b.font = { name: T.font, size: 10.5, color: { argb: T.ink } };
    b.alignment = { wrapText: true, vertical: 'top' };
    if (headline) {
      a.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: T.ink } };
      b.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: T.card } };
      b.font = { name: T.font, size: 10.5, bold: true, color: { argb: T.ink } };
    }
    dr++;
  };

  line('这张表是什么', '', true);
  line(
    '用途',
    '把已脱敏的聊天素材压成一行一份的结构化指标，用来挑「哪几份值得做成人设」。它不替代读原文，只负责把 299 份缩到十几份值得读的。',
  );
  line(
    '素材来源',
    `${meta.src || 'imports/'} 下的 redacted.json，共 ${meta.total} 份。原文与真名不在本表内，询价单号只标有无。`,
  );
  line('L1 与 L2 必须分开看', '', true);
  line(
    'L1 客观计数',
    '消息数、回合数、时间戳、订单卡状态——纯代码数出来的，可以当事实用。表头是板岩墨底。',
  );
  line(
    'L2 规则初判',
    '失单模式、置信度、人设候选分——关键词与阈值凑出来的猜测，命中不等于结论，只等于「值得人去看一眼」。表头是泓红底，单元格是浅底。判定依据列写明了命中哪条规则，逐条可复核。',
  );
  line(
    '为什么要分',
    '技术方案硬约束③：判定不准的东西不许伪装成客观。把 L2 当 L1 用，等于拿一堆正则的猜测去决定新人练什么。',
  );
  line('关键列怎么算的', '', true);
  line('回合数', '说话方切换次数 ÷ 2 向下取整。一来一回算一回合。');
  line('我方首响(分)', '客户第一条消息 → 我方第一条回复的分钟数。时间戳缺失的留空，不补估计值。');
  line('最长静默(时)', '相邻两条消息的最大间隔小时数，不区分是谁在等谁。');
  line('我方收尾后无回应', '最后一条是我方发的，且此前客户说过话 —— 「跟丢了」最硬的结构信号。');
  line('订单状态', '只认订单卡文本里的字样（已付款/已发货 vs 关闭/取消）。有单但读不出状态的标「状态待确认」。');
  line('明牌完整度', '客户面板 / 客户画像 / 采购偏好三块里有几块。v6 导出件才有，老文件普遍是 0。');
  line('人设候选分', '客户发言量、平均词数、博弈信号、明牌完整度、跨度、结局证据加权，0–100。客户发言 ≤2 条封顶 15 分；客户侧无文本直接 0。');
  line('重复嫌疑', '运行时扫当前题库包（BANK_DIR）里题目的 skeleton.tests，考点撞车的标出来。加了新人设重跑即更新。');
  line('已知不准的地方', '', true);
  line('关键词是英文为主', '客户用法语/西语/阿语交流的记录，关键词命中率会明显偏低，候选分被低估。这类记录要人工翻一遍。');
  line('「定制需求」等低置信标签', '命中一个 logo 就会打上，噪音大。当线索用，别当结论。');
  line('时间戳缺失', '老版本导出件 .time 只有时分，日期靠分隔线补。两者都缺就留空 —— 宁可空着，不编一个时间。');
  line('产品列', '优先取订单卡的「产品」字段，其次取画像的「采购需求」。都没有就留空，不从聊天正文里猜。');

  await wb.xlsx.writeFile(out);
}

/* ══════════════ main ══════════════ */

async function main() {
  const { imports, src, owners, out } = parseArgs(process.argv.slice(2));
  const dir = resolve(ROOT, imports);
  if (!existsSync(dir)) {
    console.error(`找不到素材目录：${dir}\n先跑 npm run import:chat 把聊天记录脱敏导进来。`);
    process.exit(1);
  }

  const bySlug = readOwnerFile(owners ? resolve(ROOT, owners) : '');
  const owner = bySlug.size ? new Map<string, string>() : buildOwnerMap(src ? resolve(src) : '');
  if (bySlug.size) console.log(`业务员归属：读到化名映射 ${bySlug.size} 条`);
  else if (src && owner.size === 0)
    console.log(`⚠ --src 指向的目录里没找到 html，业务员列会退回抬头里的「负责人」`);

  const coverage = readCoverage(ROOT);
  console.log(`现有人设覆盖的考点：${coverage.map((c) => c.code).join(' ') || '（没读到）'}`);

  const rows: Row[] = [];
  let bad = 0;
  for (const slug of readdirSync(dir)) {
    const f = join(dir, slug, 'redacted.json');
    if (!existsSync(f)) continue;
    try {
      const r = JSON.parse(readFileSync(f, 'utf8')) as Redacted;
      const who =
        bySlug.get(slug) ??
        owner.get(basename(r.chat?.source?.file ?? '')) ??
        r.chat?.header?.['负责人'] ??
        '';
      rows.push(buildRow(slug, r, who, coverage));
    } catch (e) {
      console.log(`✗ ${slug} 读取失败：${(e as Error).message}`);
      bad++;
    }
  }

  if (rows.length === 0) {
    console.error('一份素材都没读到，台账不生成。');
    process.exit(1);
  }

  rows.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));

  const outPath = resolve(ROOT, out);
  await write(rows, outPath, { total: rows.length, src: src || imports });

  const hi = rows.filter((r) => r.score >= 70).length;
  const mid = rows.filter((r) => r.score >= 50 && r.score < 70).length;
  console.log(`\n✓ 台账已生成：${outPath}`);
  console.log(`  共 ${rows.length} 份${bad ? `（${bad} 份读取失败）` : ''}`);
  console.log(`  候选分 ≥70：${hi} 份　50–69：${mid} 份　<50：${rows.length - hi - mid} 份`);
  console.log(`\n  下一步：按「人设候选分」降序看前 20 行，逐份读 redacted.json 原文再定。`);
  console.log(`  ★ 失单模式那几列是机器猜的，不是结论 ★\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
