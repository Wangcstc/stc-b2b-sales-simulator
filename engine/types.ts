/**
 * 引擎层类型定义
 *
 * ★ 本目录是无菌区 ★
 * 不许 import 数据库 / LLM / Next.js / 文件系统的任何东西（eslint 强制）。
 * 理由：状态机参数一定要反复调整。埋在 API 路由里和 LLM 缠在一起，
 * 每次调参都要真人聊一局——成本高到根本不会去调，参数就永远停在拍脑袋的值上。
 */

// ───────────────────────── 状态 ─────────────────────────

export interface DrillState {
  /** 耐心 0–100 */
  patience: number;
  /** 信任 0–100 */
  trust: number;
  /** 兴趣 0–100 */
  interest: number;
  /** 当前轮次，从 1 开始 */
  turn: number;
  /** 连续无新信息的轮数 */
  stagnantTurns: number;
  /**
   * ── 动作后的补充说明窗口（2026-08-19 反馈 #7）──
   *
   * 王铖当场确认的口径：「客户先不要回复，等业务员再讲一句话后再回复，
   * 也就是给我们一些再解释清楚、说得更清楚的空间。」
   *
   * ★ 为什么是状态不是配置 ★ 它回答的是「这一局此刻在等什么」——报价发出去了、
   * 客户还没开口、业务员手里还有几次说话机会。这正是状态机该管的事。
   *
   * ★ 存在 state JSON 里，不开新列 ★ Session.state 本来就是 Json，加字段不用迁移。
   * 老局的 state 里没有这一列，读作 undefined＝不在等待态，行为与 2026-08-23 之前一致。
   *
   * `used` 是**已经用掉几次**补充机会。用满 SUPPLEMENT_TURNS 的那一条消息发出去，
   * 客户才连着这个动作一起回。
   */
  awaitingReply?: {
    /** 动作发生在第几轮 */
    turn: number;
    /** 什么动作把客户按住了。进文案，让业务员知道自己在等什么 */
    action: 'quote' | DeliverableKind;
    /** 已用掉几次补充说明 */
    used: number;
  };
}

export const STATE_MIN = 0;
export const STATE_MAX = 100;

// ───────────────────────── 抽取结果（技术方案 4.3） ─────────────────────────

export const SIX_ELEMENTS = [
  'product_attr',
  'quantity',
  'customization',
  'address',
  'delivery_time',
  'other',
] as const;
export type SixElement = (typeof SIX_ELEMENTS)[number];

export const QUESTION_TYPES = ['choice', 'open', 'none'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const FOLLOWUP_LEVELS = ['1', '2', '3', '4', 'none'] as const;
export type FollowupLevel = (typeof FOLLOWUP_LEVELS)[number];

export interface Extraction {
  asked_elements: SixElement[];
  /**
   * 每一项六要素的原话出处。★ 逐项校验的依据 ★
   *
   * 老口径是「整条消息只要有一句 evidence_quote 对得上，asked_elements 全数保留；
   * 对不上就整个数组清空」——一条消息问了三项、模型只引了一句原话，三项全没。
   * 现在逐项带引文、逐项校验，引不出的只丢那一项。
   *
   * 可选：2026-08-23 之前的历史 `Message.extraction` 没有这一列，回放时按老口径处理。
   */
  asked_element_evidence?: { element: SixElement; quote: string }[];
  quantity_split_confirmed?: boolean;
  attribute_drilled?: boolean;
  asked_question: boolean;
  question_type?: QuestionType;
  has_altruistic_framing?: boolean;
  affirmed_customer?: boolean;
  emotional_expression?: boolean;
  is_empty_chase?: boolean;
  /** 因主观怀疑客户而明显降低服务投入；仅作 R2 人工复核候选信号 */
  low_investment_on_suspicion?: boolean;
  contradiction_probe?: boolean;
  cited_bg_conclusion?: boolean;
  sent_catalog?: boolean;
  followup_level?: FollowupLevel;
  followup_has_hook?: boolean;
  /** 跟进邮件带了图片/视频（第一封带图会进垃圾箱） */
  email_with_attachment?: boolean;
  evidence_quote?: string;
  /**
   * 这一条是用中文发出去的（红线④）。
   *
   * ★ 由代码写，不进 LLM schema ★ CJK 正则是纯代码判定，没有解释空间，
   * 不该交给模型。但它必须落在 `Extraction` 里——**回放工具读的是
   * `Message.extraction`**（见 `lib/replay.ts`），不落在这里，历史局就重放不出这条红线。
   */
  replied_in_chinese?: boolean;
}

/**
 * 客户那一条消息的抽取结果（调用④）。
 *
 * ★ 为什么必须单独抽客户 ★（2026-08-23 补）
 * 在这之前系统**只看业务员说了什么，从不看客户答了什么**——
 * `markVolunteered()` 与 `insightFactBasis()` 全仓只在测试里被调用，生产没有调用点。
 * 所以业务员反馈的「客户明明给了，系统抓不到」不是抽取不准，**是压根没抽**。
 */
export interface CustomerExtraction {
  /** 客户这一条里真的给出了实质答案的要素 */
  answered_elements: { element: SixElement; quote: string }[];
  /** 只给了模糊回答（"a lot" / "depends" / "we'll see"）——不算收集到，但要提示追问 */
  vague_elements: SixElement[];
}

// ───────────────────────── 事实表（需求 8.2） ─────────────────────────

/**
 * ★ 信息来源 ★（2026-08-05 手动跑局发现的字段缺口）
 * 只记「收到没收到」会把客户主动送上门的信息算成新人的功劳，洞察力虚高一档。
 * 洞察力锚点的「六要素 N 项」只计 `asked`。
 */
/**
 * 六要素是怎么到手的。
 *   asked       —— 业务员问出来的，只有这一类记他的功劳（洞察力就数这个）
 *   volunteered —— 客户主动送上门的，不算功劳
 *   preset      —— ★ 前情里就已经定死的 ★（2026-08-07 新增）
 *
 * preset 这一类是跟进局才有的：像「订单已建好、只差付款」这种局，
 * 产品、数量、定制、地址、交期在前情里全都白纸黑字写着了，
 * 业务员再问一遍反而是错的——客户会觉得你连之前谈的都不记得。
 * 可系统原先只认 asked，于是这类局的洞察力必然被判成「六要素 0 项」。
 * preset 既不算他的功劳，也不算他的缺失：它压根不该进这道题。
 */
export type ElementSource = 'asked' | 'volunteered' | 'preset';

/**
 * ★ 三态，不是打勾/不打勾 ★（2026-08-23 补，08-19 业务员反馈的第一大问题）
 *
 * 在这之前 `updateFacts()` 拿到「业务员问了数量」就直接写 `collected: true`——
 * **问了 = 收到了**。于是「我问了、客户根本没答，它也打勾」成了必然，
 * 而不是模型判得不准。
 *
 * 更要命的是红线①读的是同一个字段：问一句 "How many pieces?"、客户没答、
 * 立刻报价 → `quantity.collected` 已经是 true → **裸报价红线漏判**。
 * 那是全系统唯一 100% 可靠、可作考试硬否决的判定。
 *
 *   unasked         —— 没问过
 *   asked_no_answer —— 问了，但客户没给（或只给了"a lot"这种模糊回答）
 *   collected       —— 客户真的给了实质回答
 */
export type ElementStatus = 'unasked' | 'asked_no_answer' | 'collected';

export interface ElementRecord {
  /**
   * 三态。★ 可选是为了老数据 ★ 2026-08-23 之前落库的 `Session.facts` JSON 里没有这一列，
   * 读回来时用 `statusOf()` 从 `collected` 推，不要直接读 `.status`。
   */
  status?: ElementStatus;
  /** `status === 'collected'` 的派生值。保留是因为老 JSON 和台账都在读它 */
  collected: boolean;
  /** 第几轮拿到的 */
  turn?: number;
  source?: ElementSource;
  /** 业务员哪一轮、哪句话问的——判定依据要能上屏给人复核 */
  askedTurn?: number;
  askedQuote?: string;
  /** 客户哪一轮、哪句话答的 */
  gotTurn?: number;
  gotQuote?: string;
  /** 客户只给了模糊回答（"a lot" / "depends"）——不算收集到，但报告里要提示追问确认 */
  vague?: boolean;
}

/** 读三态。老数据没有 `status` 列，从 `collected` 推 */
export function statusOf(r: ElementRecord | undefined): ElementStatus {
  if (!r) return 'unasked';
  return r.status ?? (r.collected ? 'collected' : 'unasked');
}

export type QuoteTier = 'A' | 'B' | 'C';

/**
 * 一行报价 = 一个产品（2026-08-19 反馈 #6）。
 *
 * 业务员反馈原话：「我们这一轮谈到两个产品，那不是就有对应的两个数据吗？
 * 他报价面板就没办法处理。我是两个报价，我就按照差不多的一下子给他报过去，
 * 他那边因为系统里面没有记录，就不知道。」
 *
 * ★ 关键在最后半句 ★「系统里面没有记录」——第二个产品的价格业务员是打字发出去的，
 * 于是它对系统而言不存在：不进事实表、不进档位计算、不进点评。
 * 报价之所以能 100% 可靠地判，靠的就是它走表单；漏在表单外面的部分等于没报。
 */
export interface QuoteLine {
  /** 产品名或型号。多产品时不写清楚，客户和复盘都分不出哪个价对应哪个货 */
  product: string;
  unitPrice: number;
  quantity: number;
}

/**
 * 读一份报价的所有产品行。
 *
 * ★ 所有读报价的地方都必须走这个函数 ★ 2026-08-23 之前的历史报价记录里没有 `lines`，
 * 只有平铺的 `unitPrice`/`quantity`。不统一从这里读，老局的报告就会显示成"0 个产品"。
 */
export function quoteLines(q: QuoteRecord): QuoteLine[] {
  if (q.lines?.length) return q.lines;
  return [{ product: '', unitPrice: q.unitPrice, quantity: q.quantity }];
}

export interface QuoteRecord {
  turn: number;
  /**
   * 逐个产品的报价行（2026-08-19 反馈 #6）。可选：老记录没有这一列，
   * 读的时候一律走 `quoteLines()`，它会把老记录折成一行。
   */
  lines?: QuoteLine[];
  /**
   * ★ 首行的镜像，留给老读者 ★ 新记录里它等于 `lines[0]`。
   * 不删是因为台账、回放、历史 facts JSON 里到处都在读它——
   * 删一个还在被历史数据使用的字段，坏的是过去那些局的报告，而不是提醒你去改。
   */
  unitPrice: number;
  quantity: number;
  freight: number;
  /**
   * 贸易术语与交期（2026-08-19 反馈 #6 要求报价面板带上）。
   *
   * ★ 放在报价级、不放在产品行级 ★ 文档把它们列在产品字段那一串里，但一票货
   * 共用一套贸易术语和一个交期——逐行填等于逼业务员把同一件事抄 N 遍，还会抄出不一致。
   *
   * ★ 它们不进六要素 ★ 这是业务员【给】客户的信息，不是【问】到的。
   * 抽取口径里写得很清楚："Our lead time is 35 days." 属于给信息，不标 delivery_time。
   * 在这儿填了就给他打勾，等于凭空送两项。
   */
  tradeTerms?: string;
  leadTimeDays?: number;
  total: number;
  tier: QuoteTier;
  hasQuoteSheet: boolean;
  hasScreenshot: boolean;
  formatCompliant: boolean;
  /**
   * 面板填的数量 ≠ 暗牌真实数量 —— 说明没问清就报了。
   *
   * ★ 这不是系统出错，是数量陷阱考点 ★（2026-08-19 业务员把它读成了"数据失真"报错）
   * 人设里客户口头说 2,000、暗牌真实 5,000，业务员没追问就照 2,000 报 → 命中。
   * 判定本身是对的，错的是**只吐一行红字不给理由**。文案见 `报价` 相关 UI 与 `report.ts`，
   * 局中不许说破真实数量（泄题），局后报告里必须说透。
   */
  quantityMismatch: boolean;
  /**
   * 这一局到底有没有可对照的真实数量（2026-08-24）。
   *
   * ★ 有了它，「一致」和「压根没得比」才分得开 ★ 不是每一份人设都设了数量陷阱：
   * 暗牌里没写真实数量、或写的是区间/分款（「300 与 600 之间纠结」），
   * 代码就不该替业务员判定他报错了。false = 本局不做这项比对，`quantityMismatch` 恒为 false。
   * 可选：2026-08-24 之前的历史报价记录没有这一列，读作 true（当时的行为就是一律比对）。
   */
  quantityChecked?: boolean;
  /**
   * 报价那一刻，数量到底确认过没有（`elements.quantity` 是不是 `collected`）。
   * 有了它才能把"照客户说的填但没追问"和"客户给了还填错"分开讲。
   * 可选：2026-08-23 之前的历史报价记录没有这一列。
   */
  quantityConfirmed?: boolean;
}

/**
 * ── 动作类交付物（2026-08-19 反馈 #4）──
 *
 * ★ 为什么要有这个东西 ★ 业务员反馈原话：「发产品目录这个事情，如果我说已发送了，
 * 他后面还是会问『请发给我，请发给我』……点评那块还会说『为什么客户好几轮问你要目录
 * 你一直拖着不给』——可我们早就说发了。」
 *
 * 根因不是模型不听话，是**系统里根本没有"发目录"这个动作**。业务员只能在聊天框里
 * 打一句 "I'll send you the catalog"，那对系统来说和"承诺稍后发"没有任何区别
 * （见 `llm/extract.ts` 的 sent_catalog 口径：只是承诺"稍后发给你"不算）。
 * 客户不认账、点评倒扣分，都是这一条的必然结果。
 *
 * ★ 解法与报价同构 ★ 报价之所以能做到 100% 可靠，是因为它走表单不走聊天。
 * 交付动作照抄这条路：点按钮 → 系统投递占位附件 → 落进事实表 → 客户 prompt 里
 * 明写"这份资料你已经收到了"。口头声明与真实动作从此分得开。
 *
 * ★ 为什么做成 kind 列表而不是一个 catalogSent 布尔 ★ 文档第 2.3 条建议延伸里
 * 还列着规格书 / 样品图 / 公司介绍 / 寄样通知 / 发 PI。做成列表，将来加一种
 * 只是往 DELIVERABLE_KINDS 里加一行 + 界面上加个按钮，不用再动事实表结构。
 * ★ 本轮只开放 catalog 一种 ★ 其余几种的规则语义（发了之后客户该怎么变）
 * 还没定，没定就开放等于让新人按一个不知道会发生什么的按钮。
 */
export const DELIVERABLE_KINDS = ['catalog'] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export const DELIVERABLE_LABEL: Record<DeliverableKind, string> = {
  catalog: '产品目录',
};

/** 投递给客户的英文附件名。进对话流、也进客户 prompt，所以必须是英文 */
export const DELIVERABLE_FILENAME: Record<DeliverableKind, string> = {
  catalog: 'Product_Catalog_2026.pdf',
};

export interface DeliverableRecord {
  turn: number;
  kind: DeliverableKind;
}

/** 这一类资料发过没有。判定与文案都读它，别在别处另写一份 */
export function hasDelivered(facts: SessionFacts, kind: DeliverableKind): boolean {
  return (facts.deliverables ?? []).some((d) => d.kind === kind);
}

/**
 * R4 是 2026-08-23 王老师加的：**直接用中文向 AI 客户作答**。
 * 与 R1 同规格——纯代码判定（CJK 正则），100% 可靠，不进复核队列。
 *
 * `Redline` 是纯 TS 联合类型、`RedlineReview.code` 是 String，
 * 所以加一条不需要动数据库枚举。
 */
export type Redline = 'R1' | 'R2' | 'R3' | 'R4';

export interface SessionFacts {
  elements: Record<SixElement, ElementRecord>;
  attributeDrilled: boolean;
  quantitySplitConfirmed: boolean;
  /** 收齐六要素用了几轮；未收齐为 null */
  turnsToCollectAll: number | null;
  quotes: QuoteRecord[];
  redlines: Redline[];
  unlockedCards: { key: string; turn: number }[];
  /** 每轮是否抛了问题 */
  askedQuestionByTurn: boolean[];
  bgInitiated: boolean;
  bgItemsViewed: string[];
  bgErrorDetected: boolean;
  keyInfo: { email: boolean; whatsapp: boolean; realPurpose: boolean };
  followupLevelsUsed: { level: FollowupLevel; hasHook: boolean; turn: number }[];
  /**
   * 已经抛出过的干扰项 code。
   * ★ 必须落表，不能只记在内存 ★ 每轮都是重新从库里读出来的，
   * 不记就会同一个干扰项轮轮重抛，客户变成复读机。
   */
  distractorsFired: string[];
  /**
   * 已经真实投递给客户的资料（点按钮发的，不是嘴上说要发的）。
   * 可选：2026-08-23 之前的历史局没有这一列，`hasDelivered()` 按"没发过"处理——
   * 那也正是当时的事实。
   */
  deliverables?: DeliverableRecord[];
}

// ───────────────────────── 规则表（技术方案 3.4） ─────────────────────────

export interface RuleEffect {
  patience?: number;
  trust?: number;
  interest?: number;
  redline?: Redline;
}

export interface ExitRules {
  patienceZero: number;
  stagnantTurns: number;
  maxTurns: number;
}

export interface RuleTable {
  altruisticFraming: RuleEffect;
  choiceQuestion: RuleEffect;
  affirmCustomer: RuleEffect;
  quoteFormatCompliant: RuleEffect;
  followupWithValue: RuleEffect;
  firstReplyDirect: RuleEffect;

  quoteWithoutQuantity: RuleEffect;
  lowInvestmentOnSuspicion: RuleEffect;
  emptyChase: RuleEffect;
  quoteWithoutAttribute: RuleEffect;
  catalogBeforeNeeds: RuleEffect;
  noQuestionAsked: RuleEffect;
  onelineBigQuote: RuleEffect;
  coldContradictionProbe: RuleEffect;
  citedWrongBgConclusion: RuleEffect;
  firstEmailWithImage: RuleEffect;

  /** 红线④：用中文作答 */
  repliedInChinese: RuleEffect;

  perTurnDecay: RuleEffect;
  exit: ExitRules;
}

// ───────────────────────── 行为指令与离场 ─────────────────────────

export type ExitReason = 'patienceZero' | 'stagnant' | 'maxTurns';

export type SessionType = 'inquiry' | 'followup';

export interface Directive {
  /** 给扮演模型的自然语言行为要求 */
  tone: 'normal' | 'shorter' | 'impatient' | 'leaving';
  lines: string[];
  state: Pick<DrillState, 'patience' | 'trust' | 'interest'>;
  /**
   * 业务员这一轮发的是中文。★ 由代码判，不让模型自己看着办 ★
   * 命中时客户只回一句"看不懂，请用英文"——这一轮就白费了。
   * 这个自然代价比扣分本身更有教育意义。
   */
  chineseReceived?: boolean;
}

// ───────────────────────── 评分 ─────────────────────────

export const FORCES = ['insight', 'guidance', 'solution', 'trust', 'closing', 'negotiation', 'stability'] as const;
export type Force = (typeof FORCES)[number];

export const FORCE_LABEL: Record<Force, string> = {
  insight: '洞察力',
  guidance: '引导力',
  solution: '方案力',
  trust: '信任力',
  closing: '闭环力',
  negotiation: '博弈力',
  stability: '稳定力',
};

export type ForceScore = 1 | 2 | 3 | 4 | 5 | 'NA' | 'INSUFFICIENT';

export interface ForceResult {
  score: ForceScore;
  evidence: { turn: number; quote: string }[];
  anchor: string;
  next_action: string;
}

export type ScoreOutput = Partial<Record<Force, ForceResult>>;

export type DrillTier = 'D1' | 'D2' | 'D3' | 'D4' | 'D5';

export interface SessionScore {
  precise: boolean;
  reason?: string;
  coverage: number;
  evaluableCount: number;
  weightedAbility?: number;
  /** 最终局分（已按难度系数折算）。段位、红旗、中位数、准入判定读的都是它 */
  rawScore?: number;
  /** 折算之前的分。报告里要能说清「原始 70 → 系数 1.2 → 最终 65」 */
  baselineScore?: number;
  /** 这一局按哪个难度系数打的。1.0 = 标准难度 */
  difficultyFactor?: number;
  tier?: DrillTier;
  flags: ('high_skill_zero_progress' | 'high_score_zero_insight')[];
}
