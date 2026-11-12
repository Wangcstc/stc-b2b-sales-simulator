import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import AppShell from '@/components/AppShell';
import { requireUser, canSeeEveryone } from '@/lib/current-user';
import DifficultyClient from './DifficultyClient';
import CoachBoard from '@/components/CoachBoard';
import ExamPoolSection from './ExamPoolSection';
import { SkeletonBoard, SkeletonCard } from '@/components/Skeleton';
import Help from '@/components/Help';
import PageHelp from '@/components/PageHelp';
import Icon from '@/components/Icon';

export const dynamic = 'force-dynamic';

/**
 * 教练台（主管专属）。
 *
 * ★ 为什么全都堆在这一页 ★
 * 首页只列本人的局——那是有意的，混着别人的会把人送进同事的对话。
 * 可主管要盘人：谁在练什么、谁卡住了、谁考过了、系统判得准不准。
 * 这些以前只有台账导出（Excel，不含一句对话原文）能看到一半，
 * 剩下的得手里正好有 session id 才进得去。
 *
 * ★ 只放宽"看"，不放宽"做" ★
 * guardAct 仍然只认本人——替人聊出来的分是假的，这条不能松。
 */
export default async function Page() {
  const me = await requireUser();
  if (!canSeeEveryone(me)) notFound();

  /**
   * ★ 2026-08-26 删掉四个白跑的查询 ★
   * 标尺校准 2026-08-23 下架时，界面拆了，取数没拆——scoreCalibration 全表（还 include
   * 了 session）、calibration.count、session 取 200 条（include user/score/calibration/
   * variant.persona/_count）、user 全表，四个查询每次打开这一页都在跑，
   * 算出 rows / all / users / graded / pending / groups / 七力 Gate 统计一整套数字，
   * 然后**一个都没有出现在 JSX 里**。这一页实测 1194ms，绝大部分花在这儿。
   * 一并删掉的还有那段按人分组排序的逻辑与 ForceCell 类型引用。
   * 【要装回标尺校准，去 git 历史里捞，别照着这段注释重写】
   */

  return (
    <AppShell current="/replay">
      <div className="page-head">
        <h1>教练台</h1>
        {/* 页面级的完整口径进抽屉，标题上不再挂讲整页的「?」（2026-08-27） */}
        <PageHelp page="coach" />
        {/* ★ 台账导出的大按钮已于 2026-08-27 删除 ★
            它和版头右上角那个下载图标是**同一个接口、同一个动作**（都是 /api/ledger）。
            同一件事给两个入口，人会以为是两件不同的事——而且这个大按钮
            正对着页面标题，重量比它该有的高得多：导台账一个月未必用一次。
            版头那个图标全站每一页都在，够了。 */}
      </div>

      {/* ★ 看板排最前 ★ 待办条 → 今日判定 → 历史记录 → 登录流水。
          原来这一页打开是「标尺校准」——一个季度用一次的东西占着首屏。 */}
      <Suspense fallback={<SkeletonBoard label="正在读取今日判定与台账…" />}>
        <CoachBoard />
      </Suspense>

      {/* ── 红线人工裁定已取消（2026-08-21 下架 → 2026-08-24 王老师裁定彻底取消）──
          面板 2026-08-21 就从这一页拿掉了：红线退出准入判定之后，裁不裁都不影响谁能接询盘，
          再摆在这儿只是每天提醒主管去干一件不改变任何结果的活。
          2026-08-24 连组件与接口一起删了（原 RedlineReviewPanel、/api/redline-review）。

          ★ 取消之后红线是怎么运作的 ★
          四条全部照常检测、照常扣客户情绪、照常写进业务员报告与事实表——只是没有人去裁定。
          代价说清楚：R2/R3 是模型判的，会有误报，而误报**不再有人能翻案**。
          之所以能接受，是因为它们本来就不判生死，只是报告里的一句反馈；
          判错一次的代价是一句话说重了，不是一个人的上岗资格。
          留痕仍在写（RedlineReview 表），要查「模型这个月判了多少条 R3、准不准」直接查库。 */}

      {/* ── 标尺校准已于 2026-08-23 下架 ──
          它原来的作用是「人自己先判一遍七力，再和系统对，差得多就写成判例喂给评分模型」——
          验的是**系统打分准不准**。王老师裁定不做了，原话：
          「我没有空去每一局再这样给他们调仓和校准」。
          现在松紧靠「难度系数」一个数调（见本页最下面那一栏），不靠逐局人肉校。
          组件与接口都还在（report 页底部的 CalibrationPanel、/api/session/[id]/calibrate），
          已经攒下的判例也照常喂给评分模型；要装回来把这一段还原即可。 */}

      {/* ── 低频区：一律折叠 ── */}

      {/* ── 考试题库 ──
          ★ 默认收起，且标题旁写明「别在业务员面前打开」★
          这是全站唯一摆出考题的地方，收起来是这一块的默认状态，不是装饰。 */}
      <Suspense fallback={<SkeletonCard lines={2} />}>
        <ExamPoolSection />
      </Suspense>

      {/* ★ 全系统只剩这一个旋钮 ★（2026-08-23 王老师裁定）
          「标尺校准」（人机对照打分）与「逐项调」（改单条扣分数值并重放）都下架了——
          三个东西调的其实是两件事，而王老师要的只有一件：**跑一局拿到 65 分有多难**。
          默认展开，因为它是唯一还需要他动手的地方。 */}
      <details className="card section-fold section-block" open style={{ padding: '12px 16px' }}>
        <summary>
          难度系数
          {/* ★ 规则收进「?」，不摊在面上 ★（2026-08-23 王老师定）
              第一次看有用，第二次开始就是噪音——面上只留他要动的那几个数。 */}
          <Help topic="coach-calibration" />
          <span className="sub">调「拿到 65 分有多难」</span>
        </summary>
        <div style={{ marginTop: 14 }}>
          <DifficultyClient />
        </div>
      </details>
    </AppShell>
  );
}

const TH: React.CSSProperties = { textAlign: 'left', padding: '9px 14px', fontWeight: 400, whiteSpace: 'nowrap' };
const TD: React.CSSProperties = { padding: '9px 14px', borderTop: '1px solid var(--line)', whiteSpace: 'nowrap' };
