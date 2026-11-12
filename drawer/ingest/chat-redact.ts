/**
 * 聊天记录脱敏（不可逆）
 *
 * ★ 映射表只活在内存里 ★（王老师 2026-08-06 裁定）
 * 真名↔化名的对照不落盘、不进日志、不写进输出。代价是**跨进程不一致**：
 * 同一个客户的两份记录分两次导入，会拿到两个不同化名。
 * 所以同一个客户的多份记录必须**一次命令一起导入**（CLI 支持多文件参数）。
 *
 * ★ 替换，不是删除 ★
 * 国家、城市、港口、品类、价格、时间节奏统统保留——「西非 + 免费邮箱 + 开口就要整柜」
 * 这一整套特征就是训练价值本身，抹掉了这份记录也就废了。
 * 抹的只有能指向具体某个人／某家公司的东西。
 *
 * ★ 两道保险 ★
 * ① 已知实体字面替换（从结构化字段里拿到的确定值，含大小写与拼写变体）
 * ② 模式替换（邮箱／电话／证件号／URL／长数字）
 * 跑完再用原始实体反扫一遍输出，扫到就抛错——宁可不出货，不能漏一个真名。
 */

import type { RawChat } from './chat-parse';

export interface RedactAudit {
  category: string;
  count: number;
}

export interface RedactResult {
  chat: RawChat;
  audit: RedactAudit[];
  /** 残留自检：应当永远为空。非空说明脱敏漏了，调用方必须中止 */
  residue: string[];
  /**
   * 疑似漏网：脱敏后仍长得像人名/机构名的全大写连词。
   *
   * ★ 正则不可能抓全正文里的人名 ★ 这是给人看的，不是给机器判的。
   * 工作流是：跑一次 → 看这份清单 → 把真是人名的用 --extra 补上 → 重跑。
   */
  suspects: string[];
}

/* ─────────── 化名库 ─────────── */

/**
 * 按地区给名字，不是随便抓一个英文名换上。
 * 姓名本身携带地区信号——尼日利亚客户换成「Michael Brown」，新人一眼就觉出不对，
 * 而"这是个西非客户"恰恰是要训练的判断项之一。
 */
const NAME_POOL: Record<string, { first: string[]; last: string[]; suffix: string[] }> = {
  westafrica: {
    first: ['Chidi', 'Emeka', 'Kwabena', 'Tunde', 'Yaw', 'Ifeanyi', 'Kojo', 'Segun', 'Nnamdi', 'Kofi'],
    last: ['Okonkwo', 'Boateng', 'Adeyemi', 'Asante', 'Nwachukwu', 'Owusu', 'Balogun', 'Mensimah'],
    suffix: ['Ltd.', 'Enterprises Ltd.', 'Nigeria Ltd.', 'Trading Co.'],
  },
  arab: {
    first: ['Tariq', 'Hakim', 'Rashid', 'Yusuf', 'Karim', 'Bilal', 'Faisal', 'Nabil'],
    last: ['Al-Mansouri', 'Haddad', 'Nasser', 'Al-Rashid', 'Khalil', 'Zaman', 'Farouk'],
    suffix: ['Trading LLC', 'General Trading', 'Est.', 'FZE'],
  },
  hispanic: {
    first: ['Alvaro', 'Javier', 'Rocio', 'Ignacio', 'Nuria', 'Sergio', 'Lucia', 'Andres'],
    last: ['Sanabria', 'Cifuentes', 'Berrocal', 'Valdivia', 'Quintana', 'Escudero', 'Pineda'],
    suffix: ['S.L.', 'S.A.', 'S.A.S.', 'Comercial S.L.'],
  },
  anglo: {
    first: ['Gordon', 'Trevor', 'Fiona', 'Duncan', 'Marcus', 'Colin', 'Rowan', 'Alistair'],
    last: ['Beckworth', 'Hartley', 'Ashcombe', 'Linden', 'Marsden', 'Pemberton', 'Ravensley'],
    suffix: ['Ltd.', 'Limited', 'Group Ltd.', '& Co. Ltd.'],
  },
  southasia: {
    first: ['Rohan', 'Imran', 'Deepak', 'Faisal', 'Anil', 'Zubair', 'Nadia', 'Rakesh'],
    last: ['Chaudhary', 'Meherally', 'Ranganathan', 'Iqbal', 'Bhandari', 'Sethi', 'Qureshi'],
    suffix: ['Pvt. Ltd.', 'Traders', 'Impex', 'Industries Pvt. Ltd.'],
  },
  default: {
    first: ['Martin', 'Peter', 'Laura', 'Victor', 'Helena', 'Bruno', 'Ivan', 'Clara'],
    last: ['Halvorsen', 'Petrov', 'Vandenberg', 'Lindqvist', 'Moreau', 'Kovacs', 'Bauer'],
    suffix: ['Ltd.', 'Co., Ltd.', 'Trading BV', 'GmbH'],
  },
};

const REGION_BY_COUNTRY: [RegExp, keyof typeof NAME_POOL][] = [
  [/nigeria|ghana|尼日利亚|加纳|benin|togo|cameroon|喀麦隆|ivory|senegal|塞内加尔|多哥|贝宁/i, 'westafrica'],
  [/uae|dubai|saudi|egypt|jordan|iraq|kuwait|qatar|oman|阿联酋|沙特|埃及|迪拜|约旦|伊拉克|科威特|卡塔尔|阿曼|morocco|摩洛哥|algeria/i, 'arab'],
  [/spain|mexico|colombia|chile|peru|argentina|西班牙|墨西哥|哥伦比亚|智利|秘鲁|阿根廷|ecuador|厄瓜多尔/i, 'hispanic'],
  [/united kingdom|england|ireland|australia|canada|new zealand|英国|爱尔兰|澳大利亚|加拿大|新西兰|usa|united states|美国/i, 'anglo'],
  [/india|pakistan|bangladesh|nepal|sri lanka|印度|巴基斯坦|孟加拉|尼泊尔|斯里兰卡/i, 'southasia'],
];

const COMPANY_WORDS = [
  'Sunridge', 'Kalmar', 'Vertline', 'Norwood', 'Brightpath', 'Cedarpoint', 'Halcyon',
  'Ironvale', 'Westmark', 'Blueharbor', 'Stonebridge', 'Larkfield', 'Emberton', 'Ashgrove',
];

function regionOf(country: string): keyof typeof NAME_POOL {
  for (const [re, key] of REGION_BY_COUNTRY) if (re.test(country)) return key;
  return 'default';
}

/* ─────────── 工具 ─────────── */

/**
 * 全大写但确定不是人名的词，用来给「疑似漏网」降噪。
 *
 * ★ 词表小了这个功能就是废的 ★ 2026-08-06 实测：客户整封信通篇大写，
 * 小词表放出 37 条噪音，真人名混在里面根本看不出来——看不动的清单等于没有清单。
 * 所以这里塞的是商务英语高频词，宁可词表长，也要让清单短到人愿意看。
 */
const UPPER_OK = new Set(
  (
    // 贸易术语与单位
    'CIF FOB EXW DDP DDU FCA CFR MOQ PI TT LC OEM ODM ETA ETD HQ GP LCL FCL PCS SET SETS CTN CBM KGS KG ' +
    'USD EUR GBP RMB CNY NGN PDF JPG PNG XLS DOC CEO CFO COO MD VP HR QC QA RD BSCI FDA CE ISO SGS ROHS ' +
    'TEL FAX EMAIL MOB WHATSAPP WECHAT SKYPE ADDR STATE CITY PORT ' +
    // 招呼与礼貌
    'NO YES OK OKAY THANKS THANK DEAR HELLO HI BEST REGARDS SINCERELY PLEASE KINDLY WELCOME SORRY ' +
    'GOOD MORNING AFTERNOON EVENING FRIEND SIR MADAM ' +
    // 高频虚词与代词
    'A AN THE AND OR BUT FOR WITH FROM TO OF IN ON AT BY AS IS ARE WAS WERE BE BEEN BEING AM ' +
    'THIS THAT THESE THOSE IT ITS WE OUR OURS US YOU YOUR YOURS I MY ME HE SHE THEY THEM THEIR ' +
    'HAVE HAS HAD WILL WOULD CAN COULD SHALL SHOULD MAY MIGHT MUST DO DOES DID NOT ALL ANY SOME ' +
    'IF WHEN WHERE WHAT WHICH WHO WHY HOW THAN THEN THERE HERE NOW SOON ALSO JUST ONLY VERY MORE MOST ' +
    'ONE TWO THREE FIRST NEXT LAST OTHER SAME AFTER BEFORE ABOUT AGAIN STILL SURE LET GET GO MAKE MADE ' +
    'SEND SENT SEE LOOK KNOW NEED WANT WAIT WAITING GIVE TAKE COME BACK KEEP FIND HELP WORK ' +
    // 商务名词
    'CUSTOMIZATION CUSTOM SAMPLE SAMPLES ORDER ORDERS PRICE PRICES PRICING QUOTATION QUOTE INVOICE ' +
    'PAYMENT SHIPPING SHIPMENT DELIVERY CONTAINER PRODUCT PRODUCTS ITEM ITEMS MODEL COLOR COLOUR SIZE ' +
    'PACKING CARTON QUANTITY TOTAL AMOUNT DISCOUNT CATALOGUE CATALOG SPECIFICATION DETAILS INFORMATION ' +
    'COMPANY LIMITED LTD INC LLC CO CORP GROUP TRADING IMPORT EXPORT GENERAL ENTERPRISES MERCHANDISE ' +
    'BUSINESS MARKET MARKETING SALES SUPPLIER BUYER CUSTOMER CLIENT FACTORY MANUFACTURER ' +
    'MANAGEMENT MANAGER DIRECTOR DIRECTORS BOARD BOARDS EXECUTIVE EXECUTIVES STAFF STAFFS MEETING ' +
    'ENGINEER ACCOUNT ACCOUNTS OFFICER PURCHASE PURCHASING DEPARTMENT TEAM PARTNERSHIP PARTNER ' +
    'NAME POSITION NATIONALITY GENDER MALE FEMALE DATE BIRTH NUMBER ISSUANCE EXPIRY PASSPORT VISA ' +
    'INVITATION LETTER EMBASSY GOVERNMENT LOCAL OFFICIAL DOCUMENT REQUIREMENT REQUIREMENTS ' +
    'VISIT FACE PROPER PERFECT DECISION HAPPY GREAT LEADING SENIOR CONCERNING CONCLUDED ACCEPT ' +
    'ACCORDINGLY LISTED TAG GOODS KIND COUNTRY PREPARING SELECT SELECTED TALK MESSAGE FORWARD ' +
    'DISCUSS DISCUSSION CONFIRM CONFIRMED PLEASED GLAD RECEIVE RECEIVED PROVIDE PROVIDED ' +
    // 跨境电商与认证缩写。2026-08-06 第三轮实测补：这批词几乎占满了疑似清单
    'FBA FBM ASIN SKU UPC EAN FNSKU LISTING AMAZON EBAY SHOPIFY WALMART ETSY ' +
    'RFQ ERP CRM EXCEL WORD PPT CSV ZIP RAR PNG JPG ' +
    'BPA REACH LFGB PANTONE TPG TPX CPE PE PP PVC ABS TPE TPR EVA PET ' +
    'USA UK UAE EU US CN VIP OEM PCS CTN GW NW CBM ' +
    'MUJI IKEA COSTCO WALMART TARGET'
  ).split(/\s+/),
);

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;
const esc = (s: string) => s.replace(RE_ESCAPE, '\\$&');

/** 带重音的等价字母。西/法/葡语客户名里全是这些 */
const ACCENTS: Record<string, string> = {
  a: 'aàáâãäå', e: 'eèéêë', i: 'iìíîï', o: 'oòóôõöø', u: 'uùúûü',
  c: 'cç', n: 'nñ', y: 'yýÿ', s: 'sš', z: 'zž',
};

/**
 * 把字面串编译成「重音不敏感」的正则源。
 *
 * ★ 这条是真样本逼出来的 ★ 客户面板里的名字是 `bernardino Pardo Vazquez`（无重音），
 * 可他自己在正文和发票抬头里写的是 `Vázquez`（带重音）——字面替换一个字都匹配不上，
 * 真姓氏就这么留在输出里了。外贸客户名里的重音是常态，不是特例。
 */
function accentInsensitive(s: string): string {
  return s
    .split('')
    .map((ch) => {
      const g = ACCENTS[ch.toLowerCase()];
      return g ? `[${g}${g.toUpperCase()}]` : esc(ch);
    })
    .join('');
}

/** 深度遍历所有字符串字段。加字段不用改脱敏代码——漏字段是这类工具最典型的泄漏方式 */
function deepMapStrings<T>(v: T, fn: (s: string) => string): T {
  if (typeof v === 'string') return fn(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => deepMapStrings(x, fn)) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = deepMapStrings(val, fn);
    return out as T;
  }
  return v;
}

function deepStrings(v: unknown, acc: string[] = []): string[] {
  if (typeof v === 'string') acc.push(v);
  else if (Array.isArray(v)) for (const x of v) deepStrings(x, acc);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) deepStrings(x, acc);
  return acc;
}

/** 字面词 → 正则。exact：只认原样、首字母大写、全大写三种写法；word / exact：整词匹配 */
function literalRegex(lit: { find: string; exact?: boolean; word?: boolean }, flags: string): RegExp {
  if (lit.exact) {
    const f = lit.find;
    const forms = [...new Set([f, f[0]!.toUpperCase() + f.slice(1).toLowerCase(), f.toUpperCase()])].map(esc);
    return new RegExp(`(?<![A-Za-z])(?:${forms.join('|')})(?![A-Za-z])`, flags);
  }
  const src = accentInsensitive(lit.find);
  // 域名词不碰紧跟在 @ 和 . 后面的那一处：整个邮箱、整个网址各有规则一起抹，先抹掉半截反而让那两条认不出来
  return new RegExp(lit.word ? `(?<![A-Za-z0-9@.])${src}(?![A-Za-z0-9])` : src, `${flags}i`);
}

/** 常见顶级域名。只认这些，免得把 file.pdf、Node.js、No.1 当网址 */
const TLD = 'com|net|org|info|biz|io|co|cn|hk|tw|jp|kr|sg|my|th|vn|id|ph|in|pk|ae|sa|qa|kw|om|eg|ng|gh|ke|za|ma|tr|ru|ua|pl|cz|hu|ro|de|at|ch|nl|be|fr|it|es|pt|uk|ie|se|no|dk|fi|gr|us|ca|mx|br|ar|cl|pe|au|nz|eu|shop|store|online|site|example';
/** 网址（带或不带 http、www）。前面不许紧贴 @ ——邮箱另有规则 */
const RE_HOST = new RegExp(`(?<![@\\w.-])(?:https?:\\/\\/)?(?:www\\.)?((?:[a-z0-9-]+\\.)+(?:${TLD}))(?![a-z0-9-])(?:\\/[^\\s，。,;；)）]*)?`, 'gi');

/** 平台、免费邮箱、物流、我们自己的化名用词：它们出现在域名里不说明任何人 */
const DOMAIN_OK = new Set(
  (
    'gmail yahoo hotmail outlook live msn icloud me qq foxmail 163 126 sina sohu aol mail gmx web yandex proton protonmail zoho ' +
    'alibaba aliexpress 1688 taobao tmall alicdn amazon ebay etsy walmart shopify google youtube facebook instagram linkedin ' +
    'whatsapp wechat weixin tiktok twitter x paypal dhl fedex ups tnt usps sf maersk example '
  )
    .split(/\s+/)
    .concat(COMPANY_WORDS.map((w) => w.toLowerCase())),
);

/** 从邮箱和网址里收域名主词。≥3 个字母，平台和免费邮箱不算 */
function domainLabels(text: string): string[] {
  const hosts = [
    ...[...text.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)].map((m) => m[1]!),
    ...[...text.matchAll(RE_HOST)].map((m) => m[1]!),
  ];
  const out = new Set<string>();
  for (const h of hosts) {
    const parts = h.toLowerCase().split('.');
    parts.pop();
    if (parts.length > 1 && /^(co|com|net|org|gov|edu|ac)$/.test(parts[parts.length - 1]!)) parts.pop();
    const label = parts[parts.length - 1];
    if (label && label.length >= 3 && /[a-z]/.test(label) && !DOMAIN_OK.has(label) && !UPPER_OK.has(label.toUpperCase())) out.add(label);
  }
  return [...out];
}

/* ─────────── 脱敏器 ─────────── */

export interface RedactorOptions {
  /**
   * 额外要抹的词：自家公司中英文名与各种别名、业务员昵称等。
   * 这些在聊天正文里出现，但结构化字段里抽不到，只能显式列。
   */
  extraTerms?: string[];
}

export function createRedactor(opts: RedactorOptions = {}) {
  // 一个 redactor 实例 = 一次导入。跨文件共享，同名同化名
  const personAlias = new Map<string, string>();
  const companyAlias = new Map<string, string>();
  const counts = new Map<string, number>();
  let personSeq = 0;
  let companySeq = 0;

  const bump = (k: string, n = 1) => counts.set(k, (counts.get(k) ?? 0) + n);

  /**
   * ★ 化名必须两两不同 ★（2026-08-06 实测补）
   * 原来是 first[i%F] + last[(i*3)%L]，两个下标同步走，77 个客户里出现了
   * martin-halvorsen / martin-bauer / martin-lindqvist 这种撞名——而输出目录是按
   * 化名建的，撞名就是后一个客户把前一个的素材直接覆盖掉，数据静悄悄地少。
   * 改成名、姓分别走两个进位，F×L 组合排满再用中间名首字母开新一轮。
   */
  function aliasPerson(real: string, country: string): string {
    const key = real.toLowerCase();
    const hit = personAlias.get(key);
    if (hit) return hit;

    const pool = NAME_POOL[regionOf(country)]!;
    const i = personSeq++;
    const F = pool.first.length;
    const L = pool.last.length;
    const first = pool.first[i % F]!;
    const last = pool.last[Math.floor(i / F) % L]!;
    const round = Math.floor(i / (F * L));
    const alias = round === 0 ? `${first} ${last}` : `${first} ${String.fromCharCode(64 + round)}. ${last}`;

    personAlias.set(key, alias);
    return alias;
  }

  function aliasCompany(real: string, country: string): string {
    const key = real.toLowerCase();
    const hit = companyAlias.get(key);
    if (hit) return hit;
    const pool = NAME_POOL[regionOf(country)]!;
    const i = companySeq++;
    const alias = `${COMPANY_WORDS[i % COMPANY_WORDS.length]} ${pool.suffix[i % pool.suffix.length]}`;
    companyAlias.set(key, alias);
    return alias;
  }

  /**
   * 人名在正文里的写法千奇百怪：全大写、只写名、还有客户把 Ivy 写成 IVVY 的。
   * 所以除了全名，把每个≥4字母的单名也单独列一条；拼写变体靠 --extra 补。
   */
  function nameVariants(full: string): { find: string; exact?: boolean }[] {
    // 中文名（业务员的中文名、小名）两三个字就是全名，原来按「≥4 个字符」一刀切，整个被跳过
    if (/[\u4e00-\u9fff]/.test(full)) return full.length >= 2 ? [{ find: full }] : [];
    const parts = full.split(/\s+/).filter((p) => /^[A-Za-z][A-Za-z'’-]{2,}$/.test(p));
    const out: { find: string; exact?: boolean }[] = [full, ...parts].filter((x) => x.length >= 4).map((find) => ({ find }));
    // 两三个字母的姓（Wu、Li、Xu、Qiu、Lee、Kim）：只认整词、只认首字母大写或全大写，免得误伤 sleeve、Leeds
    for (const p of full.split(/\s+/)) if (/^[A-Za-z]{2,3}$/.test(p)) out.push({ find: p, exact: true });
    return out;
  }

  /** 消息里的发送人。导出件把自己这边写成「Me (负责人)」 */
  function senderName(raw: string): string {
    const s = raw.trim();
    return (/^Me\s*\((.*)\)$/i.exec(s)?.[1] ?? s).trim();
  }

  /**
   * @param mode.patternsOnly 只跑模式规则、指定词与疑似漏网扫描，不换人名公司名——
   *   给**已经脱敏过**的素材补跑新规则用（名字早已是化名，再换一遍只会把残留自检搞乱）
   */
  function redact(chat: RawChat, mode: { patternsOnly?: boolean } = {}): RedactResult {
    const country = String(chat.header['地区'] ?? chat.customer?.fields['国家'] ?? '');

    /* ── ① 收集已知实体 ── */
    const customerName = String(chat.header['客户'] ?? '').trim();
    const ownerName = String(chat.header['负责人'] ?? '').trim();
    const rawCompany = String(chat.customer?.fields['公司名称'] ?? '').trim();

    const literals: { find: string; repl: string; cat: string; exact?: boolean; word?: boolean }[] = [];

    /**
     * ★ 发送人也要收进来 ★（2026-11-06 推演补）
     * 抬头只写一位负责人，可真实对话里常有同事替班回复（发送人「Me (另一个业务员)」），
     * 买家那边也会换人说话（同事、老板）。这些名字不在任何结构化字段里，
     * 而疑似漏网只扫全大写词——「Nora Bell」这种正常大小写的名字会原样留下。
     */
    const persons: [string, '客户姓名' | '业务员姓名'][] = [
      [customerName, '客户姓名'],
      [ownerName, '业务员姓名'],
    ];
    for (const m of chat.messages) {
      const who = senderName(m.sender ?? '');
      if (who && !persons.some(([n]) => n.toLowerCase() === who.toLowerCase())) persons.push([who, m.side === 'me' ? '业务员姓名' : '客户姓名']);
    }

    for (const [real, cat] of persons) {
      if (!real || mode.patternsOnly) continue;
      const alias = aliasPerson(real, cat === '客户姓名' ? country : 'default');
      const aliasParts = alias.split(' ');
      for (const v of nameVariants(real)) {
        // 单名换单名、全名换全名，长度对得上读起来才自然
        const repl = v.find === real || v.find.includes(' ') ? alias : v.find === real.split(/\s+/)[0] ? aliasParts[0]! : aliasParts[1] ?? aliasParts[0]!;
        literals.push({ ...v, repl, cat });
      }
    }

    // NoCompanyName_857663380878 这种占位公司名，保留"没填公司名"这个信号，只换掉后面的号
    if (rawCompany && rawCompany !== '-' && !mode.patternsOnly) {
      if (/^NoCompanyName_/i.test(rawCompany)) {
        literals.push({ find: rawCompany, repl: 'NoCompanyName_384601815628', cat: '公司名（占位）' });
      } else {
        literals.push({ find: rawCompany, repl: aliasCompany(rawCompany, country), cat: '公司名' });
      }
    }

    // --extra 支持「原词=替换词」：人名的拼写变体（客户把 Ivy 写成 IVVY）
    // 换成 [已脱敏] 读起来很别扭，能指定成同一个化名就自然多了
    for (const t of opts.extraTerms ?? []) {
      const [rawFind, rawRepl] = t.split('=');
      const term = (rawFind ?? '').trim();
      const repl = (rawRepl ?? '').trim() || '[已脱敏]';
      // 中文两个字就是一个名字（小名、简称），原来按「≥3 个字符」一刀切，整个被跳过；
      // 两个字母的简称（公司缩写、型号前缀）只认整词，免得把普通单词拆坏
      if (/[\u4e00-\u9fff]/.test(term) ? term.length >= 2 : term.length >= 3) literals.push({ find: term, repl, cat: '指定词' });
      else if (/^[A-Za-z0-9]{2}$/.test(term)) literals.push({ find: term, repl, cat: '指定词', word: true });
    }

    /**
     * ★ 邮箱和网址里的域名就是品牌 ★（2026-11-06 推演补）
     * 邮箱整个换掉了，可域名那个词（buyer@acmecamp.example 里的 acmecamp）往往就是买家的店铺名、
     * 品牌名，正文里还会以「AcmeCamp」「ACMECAMP」各种写法出现。邮箱规则够不着，
     * 疑似漏网又只扫全大写——真实复测里漏掉的客户店铺品牌就是这一类。
     * 所以先从全文的邮箱、网址里把域名词收上来，当指定词全文抹掉（整词匹配）。
     */
    for (const label of domainLabels(deepStrings(chat).join('\n'))) {
      literals.push({ find: label, repl: '[已脱敏]', cat: '域名品牌', word: true });
    }

    // 长的先替换，避免先匹配名字片段而拆散全名。
    literals.sort((a, b) => b.find.length - a.find.length);

    /* ── ② 逐字符串替换 ── */
    const applyLiterals = (s: string): string => {
      let out = s;
      for (const lit of literals) {
        const { repl, cat } = lit;
        const re = literalRegex(lit, 'g');
        const n = (out.match(re) ?? []).length;
        if (!n) continue;
        bump(cat, n);
        // 原文全大写就还它一个全大写——ARIYO 换成 Chidi 会让语气走样
        out = out.replace(re, (m) => (m === m.toUpperCase() && m.length > 3 ? repl.toUpperCase() : repl));
      }
      return out;
    };

    const applyPatterns = (s: string): string => {
      let out = s;
      const rule = (re: RegExp, repl: string | ((...a: string[]) => string), cat: string) => {
        const n = (out.match(re) ?? []).length;
        if (n) bump(cat, n);
        out = out.replace(re, repl as string);
      };

      rule(/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g, (m: string) => {
        // 免费邮箱 vs 企业邮箱是判断项，保留域名类型
        const free = /@(gmail|yahoo|hotmail|outlook|qq|163|aol|mail)\./i.test(m);
        return free ? `buyer${(counts.get('邮箱') ?? 1)}@gmail.com` : `contact@${COMPANY_WORDS[0]!.toLowerCase()}.com`;
      }, '邮箱');

      rule(/https?:\/\/\S+/g, '[链接已移除]', '链接');
      // 不带 http 的公司官网和店铺链接也需要脱敏。
      rule(RE_HOST, '[链接已移除]', '链接');
      // 即时通讯账号：WhatsApp 号码由电话规则抹，这里抹的是字母数字混写的 ID（微信号、Skype 名）
      rule(
        /((?:whats\s?app|wechat|weixin|微信|skype|telegram|line|viber|instagram|facebook|linkedin)\s*(?:id|号|账号)?\s*[:：]\s*)([^\s,;，；。]{3,40})/gi,
        '$1[账号已脱敏]',
        '通讯账号',
      );
      // 护照/身份证：靠上下文抓，光看形状抓不准
      // 证件号可能紧贴下一个字段，结尾只排除数字。
      rule(/((?:passport|护照)[^\n]{0,24}?)\b([A-Z]{0,2}\d{6,12})(?!\d)/gi, '$1[证件号已脱敏]', '证件号');
      // 正文里的第三方姓名可能没有结构化字段。匹配到下一字段标签时停止。
      rule(
        /((?:\b(?:name|full name)|姓名|contact person|联系人)[^\n:：]{0,28}[:：]\s*)((?:(?!(?:tax|address|addr|position|nationality|gender|date|passport|tel|fax|e-?mail|mob|company)\b)[^\n,;]){3,60})/gim,
        '$1[姓名已脱敏]',
        '正文人名',
      );
      // 中文客户画像的姓名标签有时只用空格分隔。
      rule(/((?:姓名|联系人|负责人)\s*[:：]?\s*)([A-Z][A-Za-z'’.-]*(?:\s+[A-Z][A-Za-z'’.-]*){0,3})/g, '$1[姓名已脱敏]', '正文人名');
      // 地址整行抹掉。国家与城市在别的字段里另有保留，这一行对训练没有增量价值
      // 标签前置放宽到词边界：粘连数据里标签常紧贴上一段的替换标记
      // （「[税号已脱敏]Address: …」），要求前面是空白就一条都匹配不上
      rule(/((?:\b(?:addr|address)|地址)[^\n:：]{0,20}[:：]\s*)([^\n]{5,160})/gim, '$1[地址已脱敏]', '地址');
      // 带国际区号或分隔符的电话。后向只挡数字——真实数据里常和后一个字段粘成
      // 「…72138194Fax:」，挡住字母就会整条漏过去
      /**
       * 先处理带括号区号、点号分隔和四段以上的电话，避免下一条规则只吃掉前几段。
       * 数够 9–15 位数字才抹；像日期（2026-01-05）的不碰。
       */
      rule(
        /(?<![\w.])(?:\+\d{1,4}[\s.-]?)?(?:\(\d{1,5}\)[\s.-]?)?\d{1,5}(?:[\s.-]\d{2,5}){1,5}(?!\d)/g,
        (m: string) => {
          const digits = m.replace(/\D/g, '').length;
          if (digits < 9 || digits > 15 || /^\d{4}[-./]\d{1,2}[-./]\d{1,2}/.test(m)) return m;
          // 只用空格分隔、没有 + 和括号的，要四段以上才算（「500 1000 2000」这种是数量）
          if (!/[+(.-]/.test(m) && m.trim().split(/\s+/).length < 4) return m;
          return '[电话已脱敏]';
        },
        '电话',
      );
      rule(/(?<![\w.])\+?\d{1,4}[-\s]\d{2,4}[-\s]\d{4,9}(?!\d)/g, '[电话已脱敏]', '电话');
      /**
       * ≥9 位纯数字：手机号、订单号、询价单号、唛头编号。8 位以内不碰，
       * 免得误伤 20260718 这种日期。
       * 前后只排除数字，紧贴斜杠的号码也能匹配。
       */
      /**
       * 货件号、运单号、订单号这类字母数字混排的长串（亚马逊 FBA 货件号 FBA15XXXXXXX、快递单号 1Z…、LY…CN）：
       * 拿着它能查到买家的店铺和地址，必须抹。要排在「长数字」前面，否则数字段先被抹掉、剩下半截字母漏网。
       * 只认全大写、≥10 位、至少 4 个数字和 2 个字母的串——产品型号（HD-4500、SKU-001）都比这短。
       */
      rule(/\bFBA[0-9A-Z]{6,}\b|\b(?=[A-Z0-9]*\d[A-Z0-9]*\d[A-Z0-9]*\d[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z][A-Z0-9]*[A-Z])[A-Z0-9]{10,}\b/g, '[单号已脱敏]', '单号');
      rule(/(?<!\d)\d{9,}(?!\d)/g, '[数字已脱敏]', '长数字');
      // 税号／统一社会信用代码：数字+尾字母，长数字规则够不着
      // 值部分同样要在下一个字段标签处停：带 i 标志时 [A-Z0-9-] 连小写也吃，
      // 税号可能紧贴地址标签，保留标签供地址规则继续处理。
      rule(
        /((?:tax\s*id|vat|nif|cif\s*n|税号|统一社会信用代码)[^\n:：]{0,12}[:：]\s*)((?:(?!(?:address|addr|tel|fax|name|position|company)\b)[A-Z0-9-]){6,20})/gi,
        '$1[税号已脱敏]',
        '税号',
      );
      /**
       * 兜底：街道／小区／站点级地址。
       * 缺少地址标签或门牌号时，用街道和站点后缀识别，保留城市和州名。
       */
      rule(
        /\b(?:\d{1,4}[,\s]+)?[A-Z][A-Za-z'’.-]*(?:\s+[A-Z][A-Za-z'’.-]*){0,3}\s+(?:STREET|ST\.|ROAD|RD\.|AVENUE|AVE\.|LANE|CLOSE|CRESCENT|ESTATE|BUS-STOP|BUS STOP)\b/gi,
        '[街道地址已脱敏]',
        '街道地址',
      );
      /**
       * 非英语地址的街道通名可能在前面。整行替换可一并清除邮编。
       * 城市信息在国家字段和画像里另有保留，这里整行抹掉是划算的取舍。
       * 要求该行必须含数字（门牌/邮编），避免误伤「Plaza Hotel」这类普通句子。
       */
      rule(
        /^[^\n]*\b(?:Rua|Calle|Avenida|Avda|Plaza|Pza|Carrer|Paseo|Rue|Strasse|Straße|Via del|Piazza)\b[^\n]*\d[^\n]*$/gim,
        '[地址已脱敏]',
        '地址',
      );
      /**
       * 中文的公司名和街道地址（2026-11-06 推演补）：业务员发样品地址、开票信息时常写
       * 「××省××市××路 88 号」「××工贸有限公司」。英文规则一条都不认中文，疑似漏网也只扫英文大写。
       * 地址要带「路/街/道 + 门牌号」才抹，只写到城市的不碰。
       */
      // 公司名前面不吃「我们是」「贵」这类字，免得把整句一起抹掉
      rule(/(?:(?![是的在和与为我你他她贵这那写叫称开找请用])[一-龥]){2,12}(?:有限责任公司|股份有限公司|有限公司|工贸|进出口公司|贸易公司|实业公司|制品厂|工艺品厂)/g, '[公司名已脱敏]', '中文公司名');
      rule(/(?:(?![到寄是在的给发送我你他：])[一-龥]){0,20}(?:路|街|大道|巷|弄)\s*\d+\s*号(?:[\s\d\-#]*[栋幢楼层室号])*/g, '[地址已脱敏]', '地址');
      rule(/\b(\d{1,2})[-\s](JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[-\s](19|20)\d{2}\b/gi, '[生日已脱敏]', '生日');
      /**
       * 美国邮编：州缩写 + 5 位数字。邮编精确到街区，是最容易漏的一类定位信息——
       * 5 位数字太短，长数字规则不敢碰（会误伤数量与价格），只能靠「州缩写」这个锚点抓。
       * ★ 州名保留，只抹邮编 ★ 客户在哪个州是判断项，门牌精度才是隐私。
       */
      // 邮编可能紧贴下一个字段的字母，结尾只排除数字。
      rule(/\b([A-Z]{2})[,\s]+\d{5}(?:-\d{4})?(?!\d)/g, '$1 [邮编已脱敏]', '邮编');

      return out;
    };

    /**
     * ★ 模式规则跑两遍 ★（2026-08-06 第二轮实测补）
     * 规则之间存在顺序依赖，而依赖关系随数据形态变化，手工排序排不干净：
     * 地址规则先跑时，地址标签可能紧贴税号尾字母，无法匹配词边界；
     * 等税号规则把值换成 `[税号已脱敏]` 之后，`]Address` 才有词边界——可那时地址
     * 规则已经跑完了，整条地址连着邮编就留在输出里。
     * 第一遍产生的替换标记天然把粘连打断，第二遍就能吃掉第一遍够不着的。
     * 替换标记本身不会被任何规则二次命中，跑两遍是幂等的。
     */
    const redacted = deepMapStrings(chat, (s) => applyPatterns(applyPatterns(applyLiterals(s))));

    /* ── ③ 残留自检：拿原值反扫输出 ── */
    const haystack = deepStrings(redacted).join('\n');
    const residue: string[] = [];
    for (const lit of literals) {
      if ((lit.find.length >= 4 || lit.exact || /[\u4e00-\u9fff]/.test(lit.find)) && literalRegex(lit, '').test(haystack)) {
        residue.push(`${lit.cat}：仍能在输出里找到原值（${lit.find.length} 字符）`);
      }
    }
    if (/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/.test(haystack.replace(/buyer\d*@gmail\.com|contact@\w+\.com/g, ''))) {
      residue.push('邮箱：输出里还有未处理的邮箱');
    }

    /* ── ④ 疑似漏网：连着的全大写词，多半是人名或机构名 ── */
    // 我们自己发出去的化名当然会满屏都是，得先排掉，否则清单又被淹了
    const known = new Set(UPPER_OK);
    for (const alias of [...personAlias.values(), ...companyAlias.values()]) {
      for (const w of alias.split(/\s+/)) known.add(w.replace(/[.'’-]/g, '').toUpperCase());
    }

    // 单个词也要报：品牌名常常就是一个全大写词（VETA），2026-08-06 实测漏在这上面
    const suspects = new Set<string>();
    for (const m of haystack.matchAll(/\b[A-Z][A-Z'’.-]{2,}(?:\s+[A-Z][A-Z'’.-]{2,}){0,3}\b/g)) {
      const hit = m[0].trim();
      const words = hit.split(/\s+/).map((w) => w.replace(/[.'’-]/g, ''));
      // 整串都是认得的词就不报。只要有一个不认得的，整串报出来带上下文，人好判断
      if (words.every((w) => known.has(w))) continue;
      suspects.add(hit);
    }

    return {
      chat: redacted,
      audit: [...counts.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
      residue: [...new Set(residue)],
      suspects: [...suspects].slice(0, 40),
    };
  }

  return { redact };
}
