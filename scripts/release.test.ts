import { describe, expect, it } from 'vitest';
import { isForbiddenPath, isQuestionPath, looksLikeQuestion, secretHits } from './release';

describe('发布检查的判定', () => {
  it('题目文件：题库包目录和 v8 之前的旧目录都算；样品不算', () => {
    expect(isQuestionPath('p0/personas/P1-DE-002.json')).toBe(true);
    expect(isQuestionPath('banks/bank-x/1.0.0/personas/A01-DE-001.json')).toBe(true);
    expect(isQuestionPath('some/bg-packages/A03-GB-001.json')).toBe(true);
    expect(isQuestionPath('samples/bank/personas/A01-DE-001.json')).toBe(false);
    expect(isQuestionPath('standards/schema/persona.schema.json')).toBe(false);
  });

  it('内容像题：人设或背调包；格式定义、样品不算', () => {
    const q = '{"id":"A01-DE-001","open_card":{},"hidden_card":{}}';
    expect(looksLikeQuestion('fixtures/q.json', q)).toBe(true);
    expect(looksLikeQuestion('x/bg.json', '{"persona_id":"A03","ai_report":{}}')).toBe(true);
    expect(looksLikeQuestion('standards/schema/persona.schema.json', q)).toBe(false);
    expect(looksLikeQuestion('samples/src/personas/a.json', q)).toBe(false);
    expect(looksLikeQuestion('src/x.ts', q)).toBe(false);
  });

  it('密钥：真密钥、连外网又带口令的连接串算；占位、本机库不算', () => {
    // 像真的那两个串运行时才拼出来：文件里留着字面量，发布检查扫仓库时会把这份测试自己当成泄密
    const fakeKey = ['sk', 'AbCdEf0123456789AbCdEf0123'].join('-');
    const fakeUrl = ['postgresql://app', 'Real9Pass@db.example.net:5432/prod'].join(':');
    expect(secretHits('DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx')).toEqual([]);
    expect(secretHits(`key ${fakeKey}`)).toHaveLength(1);
    expect(secretHits('postgresql://drill:drill_local_dev@localhost:5433/drill')).toEqual([]);
    expect(secretHits('postgresql://user:<密码>@ep-cool.example.com/db')).toEqual([]);
    expect(secretHits(fakeUrl)).toHaveLength(1);
  });

  it('不该进发布包的路径', () => {
    expect(isForbiddenPath('.env')).toBe(true);
    expect(isForbiddenPath('workspace/drawer/seq.json')).toBe(true);
    expect(isForbiddenPath('.env.example')).toBe(false);
  });
});
