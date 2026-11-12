import { describe, expect, it } from 'vitest';
import { compileTerms, findHits } from './blacklist';

// 词全是虚构的：测试里永远不写真实客户词
const terms = compileTerms(['北峰', 'NP', 'Zorba', 'Northpeak Gear', 'Quillon=化名', '  ']);

describe('客户黑名单匹配', () => {
  it('中文按子串；长英文按子串、不分大小写；「原词=替换词」只取原词；空行跳过', () => {
    expect(terms.map((t) => t.term)).toEqual(['北峰', 'NP', 'Zorba', 'Northpeak Gear', 'Quillon']);
    expect(findHits('联系北峰工厂', terms).map((h) => h.term)).toEqual(['北峰']);
    expect(findHits('see NORTHPEAK GEARshop', terms).map((h) => h.term)).toEqual(['Northpeak Gear']);
    expect(findHits('quillons', terms).map((h) => h.term)).toEqual(['Quillon']);
  });

  it('两个字母的词只按整词、区分大小写；五个字母以内按整词', () => {
    expect(findHits('model NP-200', terms).map((h) => h.term)).toEqual(['NP']);
    expect(findHits('INPUT np snp', terms)).toEqual([]);
    expect(findHits('ZORBA team', terms).map((h) => h.term)).toEqual(['Zorba']);
    expect(findHits('zorbatron', terms)).toEqual([]);
  });

  it('报出命中所在行号', () => {
    expect(findHits('a\nb\n北峰', terms)[0]!.line).toBe(3);
  });
});
