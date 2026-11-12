/**
 * 解析 → 脱敏这条链的端到端测试（2026-08-28 第四批）。
 *
 * ★ 这条链到今天为止一条测试都没有 ★
 * 它是整个题库生产的第一段，也是产品化之后**唯一在客户机器上跑**的一段
 * （D6 选项 A：脱敏在客户那一侧，服务端只收脱敏后的 JSON）。
 * 换句话说：这段代码出错，泄漏的是客户的真实客户名单与成交价，
 * 而且泄漏之后**服务端不可能发现**——它收到的本来就是"已经脱敏"的东西。
 *
 * 用例盯三件事：
 *   ① 解析器认得出导出件的核心结构（.msg.me/.client、.sender、.time、.text、.date-divider）；
 *   ② `<br>` 变成换行——不变的话整条消息粘成一行，脱敏规则的 `[^\n]` 边界全部失效；
 *   ③ **脱敏之后真名一个字都不许剩**，这是最后一道，也是最要紧的一道。
 */

import { describe, expect, it } from 'vitest';
import { parseChatHtml } from './chat-parse-core';
import { createRedactor } from './chat-redact';

/**
 * 照**实际**导出件的结构造一份最小样本。
 * ★ 第一版是照文件头注释里的选择器名瞎写的，五条用例全红 ★ 真实结构是：
 *   · `.info` 抬头是**纯文本按「键：值」逐行解析**，不是 .k/.v 标签；
 *   · 客户面板的表格用 `th` + `td`，不是两个 `td`；
 *   · 每条 `.msg` 里还有一层 `.bubble`，`.sender` / `.time` / `.text` 都在它里面。
 * 记在这儿：写夹具要照代码里的选择器，不能照注释里的示意。
 */
function sampleHtml(): string {
  return `
<html><body>
  <div class="info">客户：Abdoul Bah
地区：Nigeria
负责人：Lily Chen</div>
  <div class="cust-box">
    <table class="ct">
      <tr><th>公司名称</th><td>Lagos Trading Ltd.</td></tr>
      <tr><th>国家</th><td>Nigeria</td></tr>
    </table>
  </div>
  <div class="date-divider">2026-05-12</div>
  <div class="msg client">
    <div class="bubble">
      <span class="sender">Abdoul Bah</span><span class="time">10:35</span>
      <div class="text">Hi Lils, please send price.<br>My email is abdoul@demo-trading.example</div>
    </div>
  </div>
  <div class="msg me">
    <div class="bubble">
      <span class="sender">Lily Chen</span><span class="time">10:40</span>
      <div class="text">Sure, our FOB price is USD 3.20.</div>
    </div>
  </div>
</body></html>`;
}

describe('parseChatHtml：吃字符串，不吃路径', () => {
  const chat = parseChatHtml(sampleHtml(), 'abdoul.html');

  it('抬头与客户面板读得出来', () => {
    expect(chat.header['客户']).toBe('Abdoul Bah');
    expect(chat.header['地区']).toBe('Nigeria');
    expect(chat.customer?.fields['公司名称']).toBe('Lagos Trading Ltd.');
  });

  it('两条消息、双方各一条，日期跟着分隔线走', () => {
    expect(chat.messages).toHaveLength(2);
    expect(chat.messages[0]!.side).toBe('client');
    expect(chat.messages[1]!.side).toBe('me');
    expect(chat.messages[0]!.date).toBe('2026-05-12');
  });

  it('source.file 用传进来的名字，不去碰路径', () => {
    expect(chat.source.file).toBe('abdoul.html');
  });

  /**
   * ★ 一条消息里的换行必须留住 ★（2026-08-06 那次事故的回归）
   * 取 `.text` 时如果 `<br>` 被吞掉，整条消息会粘成一行：
   *   「Company Name: XAddr: 40 …STREETTEL: +234…Fax: …-Name: …」
   * 后果是脱敏规则的「非换行」边界全部失效——一条 `Name:` 规则能一口吃掉后面的
   * 职位和国籍；数字紧贴字母又让电话、证件号匹配不上词边界，直接漏号。
   *
   * ★ 实测发现的一件事，记在这儿 ★ 当前版本的 node-html-parser 取 `.text` 时
   * **自己就会把 `<br>` 变成换行**，所以 `chat-parse.readHtml` 里那一步显式替换
   * 在今天是冗余的。**不要因此把它删掉**——那一步是 2026-08-06 真出过事才加的，
   * 而"当前版本恰好会做"和"这件事有保证"是两回事，换个版本或换个解析器就没了。
   * 这条用例守的是**结果**（换行在），不是守某一层实现。
   */
  it('消息里的换行必须留住，否则脱敏的行边界会全部失效', () => {
    const prepared = parseChatHtml(sampleHtml().replace(/<br\s*\/?>/gi, '\n'), 'x.html');
    expect(prepared.messages[0]!.text).toContain('\n');
    expect(prepared.messages[0]!.text).toContain('My email');
  });
});

describe('★ 脱敏之后真名一个字都不许剩 ★', () => {
  const chat = parseChatHtml(sampleHtml().replace(/<br\s*\/?>/gi, '\n'), 'abdoul.html');
  const { redact } = createRedactor({ extraTerms: ['Lils'] });
  const result = redact(chat);
  const dumped = JSON.stringify(result.chat);

  it('客户姓名不在输出里', () => {
    expect(dumped).not.toContain('Abdoul Bah');
    expect(dumped).not.toContain('Abdoul');
  });

  /**
   * ★ 这条用例必须是"只有 extraTerms 才救得了"的那种 ★
   * 第一版拿业务员全名「Lily Chen」来断言——那个名字在抬头的「负责人」字段里，
   * 脱敏本来就会自动抹掉它，于是**不管 extraTerms 传没传、传得对不对，用例都会绿**。
   * 我当时甚至把选项名写错成 `extra`（真名叫 `extraTerms`），照样过。
   * 一条两种写法都会通过的用例，不是用例。
   *
   * 现在改用只在**正文里裸写**的昵称「Lils」：任何结构化字段里都没有它，
   * 自动脱敏抓不到——这正是《素材导入操作单》里 `--extra` 存在的全部理由。
   */
  it('正文里裸写的昵称，只有 extraTerms 兜得住', () => {
    expect(dumped).not.toContain('Lils');
    // 反证：不传 extraTerms 时它会原样留在输出里
    const naked = createRedactor().redact(chat);
    expect(JSON.stringify(naked.chat)).toContain('Lils');
  });

  it('公司名与邮箱不在输出里', () => {
    expect(dumped).not.toContain('Lagos Trading');
    expect(dumped).not.toContain('abdoul@demo-trading.example');
  });

  /**
   * ★ 该留的要留 ★ 脱敏不是删干净——国家、品类、数量级、价格、时间节奏
   * 全是训练价值本身，抹掉了这份素材就做不成题了。
   */
  it('国家与价格照常留着——那是训练价值本身', () => {
    expect(dumped).toContain('Nigeria');
    expect(dumped).toContain('3.20');
  });

  it('审计计数按类目给出来，供人眼复核', () => {
    expect(result.audit.length).toBeGreaterThan(0);
    expect(result.audit.every((row) => row.count > 0)).toBe(true);
  });
});
