import { WEEKLY_EXAM_CONFIG } from '@/lib/weekly-exam';
import { FLOW_LOGINS, FLOW_SESSIONS } from './shared';
import type { HelpPage } from './types';

/**
 * 训练台（/train）的帮助内容 —— 业务员自己那一份
 *
 * ★ 和教练台共用的两节没有在这里复制 ★
 * 「历史记录」「登录流水」的口径两边一模一样，真源在 coach.tsx，
 * 这一页直接引它的 id（见 index.tsx 的 SHARED_INTO）。
 * 复制一遍就等于埋了个迟早对不上的第二真源。
 */
const W = WEEKLY_EXAM_CONFIG;

export const TRAIN_HELP: HelpPage = {
  id: 'train',
  title: '训练台',
  route: '/train',
  audience: 'staff',
  intro: '这一页的表全是你自己的数据，看不到别人，别人也看不到你的。',
  sections: [
    {
      id: 'train-scope',
      title: '这一页管什么',
      summary: '全是你自己的数据，别人看不到。门槛规则在「考前必读」里。',
      body: (v) => (
        <>
          <p>
            这一页的表全是<b>你自己的数据</b>，看不到别人，别人也看不到你的。
          </p>
          {v.track === 'WEEKLY' ? (
            <p>
              <b>本周进度</b>＝此刻算出来的，刚考完的局立刻算进去；
              <b>周考台账</b>是每晚结算时存下来的留档，一周一行。
            </p>
          ) : (
            <p>
              <b>今日判定</b>＝今天此刻算出来的结果，刚考完的局立刻算进去；
              <b>历史台账</b>是每天结算时存下来的留档。
            </p>
          )}
          <p>
            门槛和规则不在这一页，在<a href="/exam/intro">考前必读</a>里。
          </p>
        </>
      ),
    },
    {
      id: 'train-weekly-req',
      title: '你的周考要求',
      summary: '每周至少 2 场考试。只记录，不影响询盘分配，也不动任何权限。',
      body: () => (
        <>
          <p>
            你的训练要求是<b>每周至少 {W.examsPerWeek} 场</b>考试，一场 {W.sessionsPerExam} 局，
            合计 {W.sessionsPerWeek} 局出分。每天最多考 1 场，周一到周日算一周。
          </p>
          <p>
            <b>练习不限次数、不计入周考。</b>想练几局练几局，模拟询盘随时开 ——
            只有「考试闸门」开出来的局才进这张表。
          </p>
          <p>
            周考<b>只记录，不影响任何权限</b>：不影响询盘分配，也不动你的正式段位。
            没考满只会在台账上记一笔、主管那边提一句。
          </p>
          <p>
            中位数旁边那条 {W.medianScoreMin} 分是<b>参考线</b>（与实习业务员同一把尺），
            方便你知道自己在哪一档，不是门槛。
          </p>
        </>
      ),
    },
    {
      id: 'train-week-board',
      title: '周考台账',
      summary: '一周一行，周一到周日算一周。只算考试局，练习一局都不进。',
      body: () => (
        <>
          <p>
            一周一行，<b>周一到周日</b>算一周。要求是每周至少 {W.examsPerWeek} 场考试
            （{W.sessionsPerWeek} 局出分），每天最多考 1 场。
          </p>
          <p>
            <b>只算考试局。</b>模拟询盘练的那些一局都不进这张表 —— 练习不限次数，也不计分。
          </p>
          <p>
            中位数旁边那条 {W.medianScoreMin} 分是<b>参考线</b>，方便你知道自己在哪一档，不是门槛。
            周考<b>不影响询盘分配，也不影响任何权限</b>。
          </p>
          <p>「进行中」＝这一周还没过完，还没到下结论的时候。</p>
        </>
      ),
    },
    FLOW_SESSIONS,
    FLOW_LOGINS,
  ],
};
