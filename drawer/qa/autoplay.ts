/**
 * 自动对局（抽屉工序⑦ 难度校准的核心，命令行 `scripts/import/autoplay.ts` 也用它）。
 * 拿判定引擎把一道题机器打一遍：暗牌依赖链走不走得通、规规矩矩的好新人会不会提前出局、
 * 六要素收不收得齐、买家会原样说出口的台词有没有自己泄露暗牌，并量出机制难度指数。
 * 从 `scripts/import/autoplay.ts` 搬来，逻辑一字未改。
 */
import {
  detectUnlocks,
  checkLeak,
  emptyUnlockState,
  type HiddenCards,
  type UnlockState,
} from '../../engine/unlock.js';
import { emptyFacts, updateFacts, applyCustomerAnswers, countCollected } from '../../engine/facts.js';
import { initialState, updateState, checkExit } from '../../engine/state-machine.js';
import { DEFAULT_RULES } from '../../engine/rules.js';
import { SIX_ELEMENTS, type SixElement, type Extraction, type SessionType } from '../../engine/types.js';
import {
  bandOfLabel,
  mechanicalDifficulty,
  MIN_BAND_GAP,
  type DifficultyBreakdown,
} from '../../engine/difficulty-index.js';

export interface VerifyCase {
  card: string;
  should: string[];
  shouldNot: string[];
}

export interface AutoplayPersona {
  /** 旧格式的编号；题库格式 v1 用 `id`。读进来后统一由 normalize() 补齐 */
  persona_variant_id: string;
  id?: string;
  pool_type?: string;
  verify_cases?: VerifyCase[];
  /**
   * ★ 变体级难度覆盖 ★（2026-08-28 第三批）不写＝跟骨架的档位走。
   * 写了就表示「这是同一个考点的另一档」，那么它必须**真的**比兄弟难（或易）——
   * 差多少才算真，见 `MIN_BAND_GAP`，检查在 main() 里。
   */
  difficulty?: string;
  skeleton: { code: string; type_code?: string; name: string; difficulty: string; session_type: string };
  open_card: { inquiry_text?: string };
  hidden_card: HiddenCards;
  distractors?: { content: string }[];
  init_state: { patience: number; trust: number; interest: number };
  exit_lines?: Record<string, string | null>;
  quote_reactions?: Record<string, string>;
  leak_fallback?: string;
  preset_elements?: string[];
  exam_only?: boolean;
  _verify_cases?: VerifyCase[];
}

export interface Problem {
  level: '✗' | '⚠';
  what: string;
}

/**
 * 旧格式与题库格式 v1 并存期间的适配：两种格式读进来后统一成同一个形状，
 * 下面的打局逻辑一个字不用改——迁移前后用同一套逻辑打，结果才可比。
 */
/** 旧格式与题库格式 v1 都能吃：读进来先统一成同一个形状 */
export function toAutoplayShape(p: AutoplayPersona): AutoplayPersona {
  return {
    ...p,
    persona_variant_id: p.persona_variant_id ?? p.id ?? '?',
    skeleton: { ...p.skeleton, code: p.skeleton.code ?? p.skeleton.type_code ?? '?' },
    exam_only: p.exam_only ?? p.pool_type === 'admission_exam',
    _verify_cases: p._verify_cases ?? p.verify_cases,
  };
}

/** 把一张牌的全部前置牌按依赖顺序摊平 */
function chainOf(cards: HiddenCards, key: string, seen = new Set<string>()): string[] {
  if (seen.has(key)) return []; // 循环依赖，交给下面单独报
  seen.add(key);
  const reqs = (cards[key]?.requires ?? []) as string[];
  return [...reqs.flatMap((r) => chainOf(cards, r, seen)), key];
}

/** 一个「规规矩矩的好新人」这一轮说了什么。不是最优解，是及格线 */
function goodTurn(el: SixElement | null, turn: number): Extraction {
  return {
    asked_elements: el ? [el] : [],
    asked_question: true,
    question_type: turn % 3 === 0 ? 'choice' : 'open',
    has_altruistic_framing: turn % 2 === 0,
    affirmed_customer: turn % 4 === 0,
    attribute_drilled: el === 'product_attr',
    quantity_split_confirmed: el === 'quantity',
    sent_catalog: false,
    is_empty_chase: false,
  };
}

/**
 * ★ 2026-08-28：run() 除了报问题，还要把这一局的机制难度量出来 ★
 * 三个信号（打通轮数、剩余耐心、六要素收齐否）它本来就在算，只是算完就扔了。
 * 现在顺手交出去——不新增任何跑局成本。
 */
export interface RunResult {
  problems: Problem[];
  difficulty: DifficultyBreakdown | null;
}

export function runAutoplay(p: AutoplayPersona): RunResult {
  const out: Problem[] = [];
  const cards = p.hidden_card ?? {};
  const cases = p._verify_cases ?? [];
  const byCard = new Map(cases.map((c) => [c.card, c]));
  const sessionType: SessionType = p.skeleton.session_type === 'followup' ? 'followup' : 'inquiry';

  /* ── ① requires 链走不走得通 ── */
  for (const key of Object.keys(cards)) {
    const seen = new Set<string>();
    const chain = chainOf(cards, key, seen);
    if (!chain.includes(key)) {
      out.push({ level: '✗', what: `${key} 的 requires 有循环依赖，这张牌永远解不开` });
      continue;
    }
    for (const dep of chain) {
      if (!cards[dep]) {
        out.push({ level: '✗', what: `${key} 依赖的 ${dep} 不存在，这条链断了` });
      } else if (!byCard.has(dep)) {
        out.push({ level: '⚠', what: `${key} 依赖 ${dep}，但 ${dep} 没有 _verify_cases，通路未经验证` });
      }
    }
  }

  /* ── ② 按依赖顺序真打一遍：七张牌能不能全部拿到 ── */
  let unlock: UnlockState = emptyUnlockState();
  const order = Object.keys(cards).sort(
    (a, b) => chainOf(cards, a).length - chainOf(cards, b).length,
  );
  const gotten = new Set<string>();
  let turn = 0;
  for (const key of order) {
    const c = byCard.get(key);
    if (!c || !c.should.length) continue;
    let got = false;
    for (const msg of c.should) {
      turn++;
      const { fresh } = detectUnlocks(cards, msg, unlock, 2);
      for (const f of fresh) {
        gotten.add(f);
        if (!unlock.unlocked.includes(f)) {
          unlock.unlocked.push(f);
          unlock.unlockedAt[f] = turn;
        }
      }
      if (fresh.includes(key) || gotten.has(key)) {
        got = true;
        break;
      }
    }
    if (!got) {
      out.push({
        level: '✗',
        what: `按依赖顺序打到 ${key} 时，它自己的正例一条都没打开它——这局拿不到这张牌`,
      });
    }
  }
  if (gotten.size < Object.keys(cards).length) {
    const miss = Object.keys(cards).filter((k) => !gotten.has(k));
    if (miss.length)
      out.push({ level: '⚠', what: `整局打完仍有 ${miss.length} 张牌没拿到：${miss.join('、')}` });
  }

  /* ── ③ 客户会说出口的文本，自己泄不泄露暗牌 ── */
  const customerLines: [string, string][] = [];
  for (const [k, v] of Object.entries(p.exit_lines ?? {})) if (v) customerLines.push([`exit_lines.${k}`, v]);
  for (const [k, v] of Object.entries(p.quote_reactions ?? {})) if (v) customerLines.push([`quote_reactions.${k}`, v]);
  for (const d of p.distractors ?? []) customerLines.push(['distractor', d.content]);
  if (p.leak_fallback) customerLines.push(['leak_fallback', p.leak_fallback]);
  if (p.open_card?.inquiry_text) customerLines.push(['open_card.inquiry_text', p.open_card.inquiry_text]);
  for (const [where, text] of customerLines) {
    const hits = checkLeak(cards, text, emptyUnlockState());
    if (hits.length)
      out.push({
        level: '✗',
        what: `${where} 这句客户会原样说出口，却命中了自己的泄露信号：${hits.map((h) => `${h.card}「${h.signal}」`).join('、')}`,
      });
  }

  /* ── ④ 一个规规矩矩的好新人打 20 轮，局会不会提前死 ── */
  const preset = (p.preset_elements ?? []) as SixElement[];
  let facts = emptyFacts(preset);
  let state = initialState(p.init_state?.interest ?? 60);
  state = { ...state, patience: p.init_state?.patience ?? 70, trust: p.init_state?.trust ?? 60 };
  const todo = SIX_ELEMENTS.filter((e) => !preset.includes(e));
  /**
   * ★ 收完六要素之后不能就地摆烂 ★（第一版就栽在这）
   * 真实的一局里，六要素收齐只是前半段，后半段是挖暗牌。我第一版让好新人
   * 收完六项就空转，`asked_elements` 变空 → 引擎判「连续 3 轮无新信息」→ 全池 30 局
   * 齐刷刷 stagnant 出局。那不是人设的问题，是模拟的人不像人。
   * 现在后半段改成逐张打暗牌，每打开一张就是一次 producedNewInfo。
   */
  const probes = order.map((k) => byCard.get(k)?.should?.[0]).filter((x): x is string => !!x);
  let probeUnlock: UnlockState = emptyUnlockState();
  let died: string | null = null;
  let finishedAt: number | null = null;
  for (let t = 1; t <= 20; t++) {
    const el = todo[t - 1] ?? null;
    const ext = goodTurn(el, t);
    let newInfo = ext.asked_elements.length > 0;
    if (!el) {
      // 六要素收完了，改成挖暗牌
      const msg = probes[t - 1 - todo.length];
      if (msg) {
        const { fresh } = detectUnlocks(cards, msg, probeUnlock, 2);
        for (const f of fresh) {
          if (!probeUnlock.unlocked.includes(f)) {
            probeUnlock.unlocked.push(f);
            probeUnlock.unlockedAt[f] = t;
          }
        }
        newInfo = fresh.length > 0;
      }
    }
    facts = updateFacts(facts, ext, t);
    /**
     * ★ 客户得回答，不然这个模拟不是「好新人打一局」，是「好新人对着空气问 20 遍」★
     * （2026-08-28 修的一个静默回归）
     *
     * `updateFacts` 只把要素标成 `asked_no_answer`——那是 2026-08-23 事实表改三态之后的
     * 正确行为：问了 ≠ 收到了。但这个模拟从来没配上 `applyCustomerAnswers`，
     * 于是 `countCollected(facts,'asked')` 永远是 0 → `doneElements` 永远为假 →
     * 好新人永远干不完活 → 20 轮耐心耗光被判离场。
     *
     * **后果是整道闸对全池 146 份人设一直报红（146 局 146 处硬问题）**，
     * 而《人设编写须知》写着这道闸必须「硬问题 0 处」才算交付。
     * 一道永远红着的闸等于没有闸——红久了就没人看了，这正是它该防的那类事故。
     *
     * 这里让客户当轮就把问到的那一项答掉：既然模拟的是"规规矩矩的好新人"，
     * 对面就该是"正常配合的客户"。真实局里客户答不答由暗牌与状态机决定，
     * 那是跑局的事；这道闸量的是**下限通路**，客户配合是这个下限的一部分。
     */
    if (el) {
      facts = applyCustomerAnswers(facts, { answered_elements: [{ element: el, quote: `autoplay:${el}` }], vague_elements: [] }, t);
    }
    const r = updateState(state, ext, facts, DEFAULT_RULES, { producedNewInfo: newInfo });
    state = r.state;

    /**
     * ★ 判定的是「打不打得通」，不是「熬不熬得满 20 轮」★（第二版又栽了一次）
     * 六要素收齐 + 暗牌全开，这一局的活就干完了，接下来是报价与收口。
     * 我第二版没有终点，好新人干完活之后继续空转，照样被判 stagnant——
     * 那是在惩罚一个已经赢了的人。现在干完就收，只有**干完之前**掉出去才算问题。
     */
    const doneElements = countCollected(facts, 'asked') + preset.length >= SIX_ELEMENTS.length;
    const doneCards = probeUnlock.unlocked.length >= Object.keys(cards).length;
    if (doneElements && doneCards) {
      finishedAt = t;
      break;
    }

    const exit = checkExit(state, facts, sessionType, DEFAULT_RULES);
    if (exit) {
      died = `${exit}（第 ${t} 轮，耐心 ${state.patience} 信任 ${state.trust} 兴趣 ${state.interest}）`;
      break;
    }
  }
  if (died) {
    out.push({ level: '✗', what: `好新人规规矩矩打，活没干完就掉出去了：${died}` });
  } else if (finishedAt === null) {
    out.push({
      level: '⚠',
      what: `20 轮打满仍没能「六要素收齐 + 暗牌全开」，这局对新人可能偏重`,
    });
  } else if (finishedAt > 16) {
    out.push({ level: '⚠', what: `打通用了 ${finishedAt} 轮，离 20 轮上限只剩 ${20 - finishedAt} 轮容错` });
  }

  /* ── ⑤ 六要素在这一局收不收得齐 ── */
  const collected = countCollected(facts, 'asked') + preset.length;
  if (collected < SIX_ELEMENTS.length) {
    out.push({
      level: '⚠',
      what: `打满 20 轮六要素只到 ${collected}/6（preset ${preset.length} 项）——洞察力会被系统性判低`,
    });
  }

  /* ── ⑥ 开局状态是否离死线太近 ── */
  const { patience = 0, trust = 0, interest = 0 } = p.init_state ?? {};
  if (patience <= 30)
    out.push({ level: '⚠', what: `开局耐心只有 ${patience}，容错约 ${Math.floor(patience / 6)} 轮，确认是有意为之` });
  if (interest <= 30) out.push({ level: '⚠', what: `开局兴趣只有 ${interest}，客户随时可能走` });
  if (trust <= 20) out.push({ level: '⚠', what: `开局信任只有 ${trust}，新人几乎没有犯错空间` });

  /* ── ⑦ 机制难度指数（2026-08-28 第三批） ── */
  const cardKeys = Object.keys(cards);
  const difficulty = mechanicalDifficulty({
    initialPatience: p.init_state?.patience ?? 70,
    finishedAt,
    patienceLeft: state.patience,
    died,
    collectedElements: collected,
    cardCount: cardKeys.length,
    // 依赖链最长几层。chainOf 摊平的是「这张牌 + 它全部前置」，所以 -1 才是深度
    maxRequireDepth: cardKeys.reduce((max, k) => Math.max(max, chainOf(cards, k).length - 1), 0),
    dualGateCards: cardKeys.filter((k) => (cards[k]?.unlock_patterns_topic ?? []).length > 0).length,
    distractorCount: (p.distractors ?? []).length,
  });

  /**
   * ★ 这里**不**拿指数去判档位 ★（2026-08-28，写完当天就按实测数据改掉的一版设计）
   *
   * 第一版在这儿写的是「声明档位与实测指数对不上就报警」。全池一跑，
   * 146 份里 143 份报警——因为标签量的是**认知难度**（这个考点难不难想明白），
   * 指数量的是**机制难度**（跑通要几轮、耗多少容错）。两把尺不是同一个东西，
   * 「简单」档在机制上恰恰最重（中位 50，而标准档只有 34）。
   * 一条会响 143 次的告警，和没有这条告警是一回事。理由详见 `difficulty-index.ts`。
   *
   * 现在只在变体**自己声明了档位覆盖**时才检查，而且检查的是「跟同考点的兄弟拉开了没有」——
   * 那是相对量，站得住。检查在 main() 里做，因为它要看到同一考点的其他变体。
   */
  return { problems: out, difficulty };
}

