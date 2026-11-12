import type { HelpPage } from './types';

/** 模拟询盘（/inquiries）的帮助内容 */
export const INQUIRIES_HELP: HelpPage = {
  id: 'inquiries',
  title: '模拟询盘',
  route: '/inquiries',
  audience: 'all',
  intro: '挑一封询盘开练。这里的局不限次数、不计入准入，练砸了不影响任何考核。',
  sections: [
    {
      id: 'inquiries-pick',
      title: '怎么挑一封开练',
      summary: '这里的局不限次数、不计入准入，练砸了不影响考核。',
      body: () => (
        <>
          <p>
            上面那排先<b>选考点</b>（或按难度、局型、练没练过筛），下面就只剩符合的封。
          </p>
          <p>
            挑中哪一行，点右边<b>「接待」</b>直接开局；不想挑就点<b>「随机来一封」</b>。
          </p>
          <p>
            这里的局<b>不限次数、不计入准入</b>，练砸了不影响你任何考核 ——
            放开了试，故意踩坑才划算。今天该练哪三封，回<a href="/">今日待接待</a>看。
          </p>
        </>
      ),
    },
  ],
};
