import localFont from 'next/font/local';

/**
 * 全站字体。**四个文件全部自托管**，构建期与运行期都不连任何外部字体服务。
 *
 * ★ 为什么必须自己托管 ★
 * 在这之前 globals.css 声明的是 `Noto Sans SC, Inter, ... JetBrains Mono`，
 * 但全站没有一处 @font-face / next/font / Google Fonts——三套字体一个都没加载。
 * 浏览器实测：Inter 与 JetBrains Mono 在这台机器上根本没装，于是
 * 拉丁字回落 Segoe UI、等宽回落 Consolas、中文回落**微软雅黑**。
 * 整套字号、字重、letter-spacing 都是照着 Inter 的字面调的，回落之后全部失准。
 * 不走 Google Fonts CDN 是另一条硬理由：这套系统给国内团队用，
 * fonts.gstatic.com 不稳，构建期拉不到就整个 build 失败。
 *
 * ★ 中文为什么拆成两个文件 ★
 * Noto Sans SC 全量 17MB，按 GBK 完整子集化之后仍有 5.3MB——一次性加载太重。
 * 拆成「常用」+「生僻」两级，靠**两个不同的家族名做级联**（见 globals.css 的 font-family）：
 * 浏览器渲染某个字时按家族顺序找，在 sc 里找不到才会去下 sc-ext。
 * 于是绝大多数页面只花 1.7MB，只有真的出现生僻字（多半是人名）时才补下 3.7MB。
 *   · sc     —— 源码里出现过的 2071 字 ∪ GB2312 全部 6763 字 ∪ 标点符号
 *   · sc-ext —— GBK 减去上面那批，14103 字。犇 喆 昇 这类人名用字在这里
 *
 * ★ 这个办法比 unicode-range 好在哪 ★ 等价的 unicode-range 写法要在 CSS 里
 * 塞 7000 多个码位、约 67KB 的范围声明（两级各 3600 段，字集是散的，压不成连续区间）。
 * 家族名级联是浏览器原生的逐字回退，两行 CSS 做到同一件事。
 *
 * ★ 字重轴收窄到 400–700 ★ 界面上实际只用到 400 / 500 / 600 / 700 四档。
 * 可变字体一个文件覆盖全部四档，比「静态 400 + 静态 700 两个文件」还小
 * （实测 1732KB vs 1932KB），而且 500 / 600 不用再靠合成。
 *
 * ★ 只有小文件 preload ★ 拉丁与等宽各三十来 KB，抢在首屏之前下完；
 * 中文那两个走 display:'swap'——先用系统字把字显出来，下完再换，
 * 不让 1.7MB 卡住首屏。
 *
 * 【要改字集或换字体，跑 scripts/build-fonts.py，别手改 woff2】
 */

/** 拉丁字母、数字、ID。字号与字距都是照着它调的 */
export const inter = localFont({
  src: './fonts/inter.woff2',
  variable: '--font-sans',
  weight: '400 700',
  display: 'swap',
});

/** 中文常用字。不 preload：1.7MB 抢首屏带宽不划算，swap 已经保证字先出来 */
export const sc = localFont({
  src: './fonts/sc.woff2',
  variable: '--font-sc',
  weight: '400 700',
  display: 'swap',
  preload: false,
  // ★ 关掉 Arial 度量回退 ★ 它会往同一家族里插一个按 Arial 度量调整过的面，
  // 而我们要的是「找不到就交给下一个家族」这条原生链路，多插一层只会让回退顺序难以推理。
  adjustFontFallback: false,
});

/**
 * 中文生僻字。只有页面上真的出现这些字时才会被下载。
 *
 * ★ unicode-range 是必须的，别删 ★
 * 不加这一条，它会被**任何**前面几个家族都没有的字符触发下载——首当其冲是 emoji。
 * 浏览器的逐字回退是这样走的：拿到「📥」，inter 没有、sc 没有，于是它必须
 * 把 scExt 整个下下来才能确认这里也没有，最后才落到系统 emoji 字体。
 * 3.8MB 就为了确认一件注定为否的事（改之前实测：首页白下 3863640 字节）。
 * 圈死在汉字区之后，非汉字一律不匹配它，也就不会再有这一次下载；
 * 而真正的生僻汉字（犇 喆 昇 这类人名用字）仍然照常触发。
 *   U+4E00-9FFF   基本汉字
 *   U+3400-4DBF   扩展 A（GBK 里那部分）
 *   U+F900-FAFF   兼容汉字
 */
export const scExt = localFont({
  src: './fonts/sc-ext.woff2',
  variable: '--font-sc-ext',
  weight: '400 700',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: 'unicode-range', value: 'U+4E00-9FFF, U+3400-4DBF, U+F900-FAFF' }],
});

/** 等宽：简码、演习 ID、日期、题库编号 */
export const mono = localFont({
  src: './fonts/mono.woff2',
  variable: '--font-mono',
  weight: '400 700',
  display: 'swap',
});

/** 挂到 <html> 上的类名，四个字体变量一次给全 */
export const fontVars = `${inter.variable} ${sc.variable} ${scExt.variable} ${mono.variable}`;
