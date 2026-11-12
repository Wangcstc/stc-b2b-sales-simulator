import { describe, expect, it } from 'vitest';
import type { Persona } from '../../bank-kit/index';
import { smokeQuestion } from './bank-loader';

const q = (open: Record<string, unknown>, productName = 'Jar') =>
  ({ open_card: open, product: { name: productName } }) as unknown as Persona;

const full = {
  name: 'A',
  country: 'Poland',
  company: 'C',
  buyer_level: 'A',
  registered_at: '2020-01',
  email: 'a@example.com',
  inquiry_text: 'Hi',
  categories: ['Outdoor'],
  tags: [],
};

describe('装入冒烟', () => {
  it('买家扮演要读的字段齐全：通过', () => {
    expect(smokeQuestion(q(full))).toEqual([]);
  });

  it('缺字段、该是数组的不是数组、产品没名字：逐条报出来', () => {
    const { email: _e, ...noEmail } = full;
    expect(smokeQuestion(q({ ...noEmail, tags: 'x' }, ''))).toEqual(['open_card.email 缺失', 'open_card.tags 应为数组', 'product.name 缺失']);
  });
});
