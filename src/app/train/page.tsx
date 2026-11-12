import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import AppShell from '@/components/AppShell';
import CoachBoard from '@/components/CoachBoard';
import WeeklyBoard from '@/components/WeeklyBoard';
import PageHelp from '@/components/PageHelp';
import { requireUser, canSeeEveryone } from '@/lib/current-user';
import { examTrackOf } from '@/lib/exam-track';
import Icon from '@/components/Icon';
import { SkeletonBoard } from '@/components/Skeleton';

export const dynamic = 'force-dynamic';

/**
 * 训练台——教练台的单人版。
 *
 * ★ 2026-08-22 王老师定：业务员没有教练台，但该有一个训练台 ★
 * 主管在教练台上看的四张表（今日判定 / 历史台账 / 历史记录 / 登录流水），
 * 业务员该看得到**自己那一份**：他每天卡在哪一条、这两周怎么走的、
 * 哪一局是练手哪一局是考试、自己什么时候登过——这些本来就是他自己的数据，
 * 藏起来他就只能靠首页那一句「未达标」猜自己差在哪。
 *
 * ★ 数据收窄在 CoachBoard 里做，不在这一页筛 ★ 传 scopeUserId，
 * 四张表的取数一律带上这个人的 id。页面这一层不碰数据，也就没机会漏筛。
 *
 * ★ 待办条不给 ★ 它是「今天谁没考、谁在等我裁」——那是主管的活，
 * 而且天生是全员的，给业务员看等于把同事的进度摊开。
 */
export default async function TrainPage() {
  const me = await requireUser();
  /**
   * ★ 2026-08-24：正式业务员也有训练台 ★
   * 原来这里是「非 INTERN 一律 notFound」，于是正式业务员连自己练了几局、
   * 什么时候登过都看不到——那本来就是他自己的数据。
   *
   * 两条轨看的是两套表：准入轨看今日判定 + 历史台账（窗口 6 格、期别、差多少分），
   * 周考轨看本周进度 + 周考台账。**下面两张流水表两条轨共用。**
   * 主管仍然走教练台，不进这一页。
   */
  /**
   * ★ 2026-08-26：不参加考试的人不再撞 404，改成送回他自己那一页 ★
   * `examTrackOf` 返回 null 的是两种人，过去一律 notFound()——地址栏敲了 /train
   * （或从别处点进来）就是一个「页面不存在」的死胡同，既不说为什么，也不给下一步。
   * 而这两种人各自都有一页**本来就该看的**：
   *   · 主管 → 教练台。他在那儿看的是全员四张表，训练台只是它的单人版，
   *     本来就不该进（这一条是原设计，没变，变的只是从 404 变成把他送过去）。
   *   · 身份待确认的业务员 → 首页。那儿有「账号身份尚未确认，请主管去设」那条黄框，
   *     正是他要的答案；把他关在 404 后面，他只会以为系统坏了。
   */
  const track = examTrackOf(me);
  if (track === null) redirect(canSeeEveryone(me) ? '/replay' : '/');

  return (
    <AppShell current="/train">
      <div className="page-head">
        <h1>训练台</h1>
        {/* ★ 把轨传进去 ★ 「今日判定」和「本周进度」是两套说法，
            不传的话正式业务员看到的是准入那套——对他一条都不成立 */}
        <PageHelp page="train" vars={{ track }} />
        {/* ★ 「导出我的台账」大按钮已于 2026-08-27 删除 ★
            和版头右上角那个下载图标是同一个接口（/api/ledger，按身份过滤：
            主管导全员、业务员只导自己）。一个动作两个入口，只会让人以为是两件事。 */}
      </div>

      {/* ★ 两块表都很沉 ★ CoachBoard 要按人补结算、WeeklyBoard 要补周结算，
          实测这一页服务端 1422ms，是全站最慢的一页。挂 Suspense 之后
          版头和标题先出来（那部分只要 156ms），表自己在后面补。 */}
      <Suspense fallback={<SkeletonBoard label="正在读取你的训练数据…" />}>
        {track === 'ADMISSION' ? <CoachBoard scopeUserId={me.id} /> : <WeeklyBoard userId={me.id} />}
      </Suspense>
    </AppShell>
  );
}
