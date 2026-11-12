/**
 * 客户黑名单匹配（纯函数，读文件、调 git 都在 `check-blacklist.ts`）。
 *
 * ★ 为什么要有它 ★ 仓库要能卖、能公开，客户信息一个字都不能进来。2026-11-06 一天里漏进来两次：
 * 测试用例里抄了一个真实货件号、代码注释里举例写了一个真实业务员的名字——都是事后复扫才抓到。
 * 靠自觉守不住，所以每次提交前机器扫一遍。
 *
 * 词表本身是客户信息，**不在仓库里**：路径从环境变量读（`BLACKLIST_FILE`，没配就用 `DRAWER_MASK_FILE`），
 * 格式与抽屉的脱敏词表文件相同（一行一个词，`#` 后是注释，「原词=替换词」只取原词）。
 */

export interface Term {
  term: string;
  re: RegExp;
}

export interface Hit {
  term: string;
  line: number;
  text: string;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 匹配口径：
 *   中文：原样子串；
 *   两个字母以内的英文（公司缩写、型号前缀）：整词、区分大小写——「NP」不能把 INPUT、snp 报出来；
 *   五个字母以内的英文：整词、不分大小写；
 *   更长的英文：子串、不分大小写（品牌拼在别的词里也要抓，比如 acmecampstore）。
 */
export function compileTerms(raw: string[]): Term[] {
  const out: Term[] = [];
  for (const r of raw) {
    const term = (r.split('=')[0] ?? '').trim();
    if (!term) continue;
    let re: RegExp;
    if (/[一-鿿]/.test(term)) re = new RegExp(esc(term), 'g');
    else if (term.length <= 2) re = new RegExp(`(?<![A-Za-z0-9])${esc(term)}(?![A-Za-z0-9])`, 'g');
    else if (term.length <= 5) re = new RegExp(`(?<![A-Za-z0-9])${esc(term)}(?![A-Za-z0-9])`, 'gi');
    else re = new RegExp(esc(term), 'gi');
    out.push({ term, re });
  }
  return out;
}

export function findHits(text: string, terms: Term[]): Hit[] {
  const hits: Hit[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const t of terms) {
      t.re.lastIndex = 0;
      if (t.re.test(line)) hits.push({ term: t.term, line: i + 1, text: line.trim().slice(0, 160) });
    }
  });
  return hits;
}
