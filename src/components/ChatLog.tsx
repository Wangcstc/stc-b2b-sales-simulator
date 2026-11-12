/**
 * 只读聊天记录。
 *
 * ★ 为复盘页而生 ★
 * 复盘问的是「第 3 轮你为什么选择用『3天有效期』推他」——
 * 新人要是看不到那一轮说过什么，只能凭印象编，而编出来的答案没有复盘价值。
 * 所以复盘页把这份记录摆在旁边，一边对着看一边答。
 *
 * 渲染口径与跑局页保持一致，两条都是踩过坑立下的：
 *   ① 跟进局开场摆的是「本局前情」不是「客户 · 询盘」——标错了会被当成客户刚说的话；
 *   ② 第 0 轮那条 role='system' 是留给模型读的前情原文，不能画成客户发言（会重复一遍）。
 */

export interface LogMsg {
  turn: number;
  role: string;
  content: string;
}

function Bubble({ who, label, children }: { who: 'me' | 'them'; label: string; children: React.ReactNode }) {
  const me = who === 'me';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start' }}>
      <div className="tiny faint" style={{ marginBottom: 4 }}>
        {label}
      </div>
      <div className={me ? 'bubble me' : 'bubble them'}>{children}</div>
    </div>
  );
}

export default function ChatLog({
  inquiryText,
  followup,
  messages,
}: {
  inquiryText: string;
  followup: boolean;
  messages: LogMsg[];
}) {
  return (
    <>
      <Bubble who="them" label={followup ? '本局前情' : '客户 · 询盘'}>
        {inquiryText}
      </Bubble>

      {messages
        .filter((m) => m.role !== 'system')
        .map((m, i) => (
          <Bubble
            key={i}
            who={m.role === 'trainee' ? 'me' : 'them'}
            label={`${m.role === 'trainee' ? '你' : '客户'} · 第 ${m.turn} 轮`}
          >
            {m.content}
          </Bubble>
        ))}
    </>
  );
}
