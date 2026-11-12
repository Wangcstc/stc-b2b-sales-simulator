'use client';

import { useEffect, useState } from 'react';
import Icon from './Icon';

/**
 * 新人指引（据知识库《新人使用说明》落到界面上，随它同步改）
 *
 * ★ 不把手册搬上网 ★
 * 手册的唯一真源在知识库，两边复制迟早不同步（README 开篇就写着这条）。
 * 这里只做一件事：**在你要动手的地方，告诉你这一步该干什么**。
 * 所以**开局这两张卡**留在动手的地方，不搬进帮助中心：
 *   ① 首页欢迎卡 —— 回答「我该点哪」
 *   ② 对话页开局卡 —— 回答「第一句发什么」，这是新人卡最久的一步
 *   ③ 右上角「帮助中心」（书图标）—— 忘了随时查，关掉的卡也能从 /help 底部放回去
 *
 * ★ 为什么是"看过就不再出现"，而不是常驻 ★
 * 常驻的提示第三天就变成背景板，谁也不看了。真正天天要用的东西
 * （Ctrl+K、六要素图例、报价档位）不放这儿，直接刻在对话页对应控件旁边。
 *
 * ★ 存 localStorage，不存服务端 ★
 * 取舍是：换台电脑再看一次没什么损失，
 * 而存进 User 表要为一件纯前端的事加一次写库、一条迁移和一个接口。
 */

const HOME_KEY = 'drill-guide-home-v1';
const DRILL_KEY = 'drill-guide-drill-v1';

/**
 * 读「这张卡关掉了没」。
 *
 * ★ 挂载前一律不画 ★ 服务端不知道这台机器关没关过，
 * 直接渲染的话，已经关掉的人每次刷新都会看见卡片闪一下再消失——
 * 那比晚出现半拍烦人得多。
 */
function useDismissable(key: string): { show: boolean; dismiss: () => void } {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(key) !== 'done') setShow(true);
    } catch {
      // 隐私模式下 localStorage 会抛。那就每次都显示——
      // 指引多看一次不伤人，为这个把它整个关掉才是损失
      setShow(true);
    }
  }, [key]);

  return {
    show,
    dismiss: () => {
      setShow(false);
      try {
        localStorage.setItem(key, 'done');
      } catch {
        /* 同上：记不住就记不住，不影响这次关闭 */
      }
    },
  };
}

/** 把关掉的卡全部放回来。给 /help 底部那个按钮用 */
export function resetGuideCards() {
  try {
    localStorage.removeItem(HOME_KEY);
    localStorage.removeItem(DRILL_KEY);
  } catch {
    /* 隐私模式下本来就每次都显示，无事可做 */
  }
}

/** 指引卡统一外观：左边一条强调色竖纹，和首页询盘分档的色带语言一致 */
function GuideCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div
      className="card"
      style={{
        borderColor: 'var(--accent)',
        background: 'var(--accent-dim)',
        borderLeftWidth: 3,
        borderLeftStyle: 'solid',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Icon name="compass" size={17} style={{ color: 'var(--accent-text)' }} />
        <b style={{ fontSize: 'var(--fs-base)' }}>{title}</b>
      </div>
      {children}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>{footer}</div>
    </div>
  );
}

/** 一条带序号的步骤 */
function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginTop: 7 }}>
      <span
        className="num tiny"
        style={{
          flexShrink: 0,
          width: 18,
          height: 18,
          lineHeight: '18px',
          textAlign: 'center',
          borderRadius: 'var(--r-xs)',
          background: 'var(--accent)',
          color: 'var(--on-accent)',
        }}
      >
        {n}
      </span>
      <span className="small" style={{ lineHeight: 1.75 }}>
        {children}
      </span>
    </div>
  );
}

/**
 * ① 首页欢迎卡：回答「我该点哪」
 *
 * 三步就是新人打开首页到开聊之间的全部动作，多一条都是负担。
 * 「练砸了不影响考核」写在最后一行，且必须写——新人不敢乱试，练不出东西来。
 */
export function HomeGuide() {
  const { show, dismiss } = useDismissable(HOME_KEY);
  if (!show) return null;

  return (
    <div className="section-block">
      <GuideCard
        title="第一次来？三步就能开练"
        footer={
          <>
            <button className="primary" onClick={dismiss}>
              知道了，开始练
            </button>
            <span className="tiny faint">忘了随时点右上角的「帮助中心」</span>
          </>
        }
      >
        <Step n={1}>
          下面<b>三封询盘</b>是今天派给你的（简单、标准、困难各一封），挑一封点「接待」就行。
          练完一封会自动补一封新的上来；想练指定考点，点最下面的「全部询盘」。
        </Step>
        <Step n={2}>
          <b>客户全程说英文。</b>你可以打中文——按 <span className="mono">Ctrl+K</span> 一键译成商务英语，译完还能改，不会替你发出去。
        </Step>
        <Step n={3}>
          目标是把右边<b>六要素</b>问齐（产品属性 / 数量 / 定制 / 地址条款 / 到货时间 / 其他）。
          <b style={{ color: 'var(--bad)' }}>数量没确认死，绝对不能报价</b>——那是红线。
        </Step>
        <div className="tiny faint" style={{ marginTop: 12, lineHeight: 1.7 }}>
          这里的局不限次数、不计入准入，练砸了不影响你任何考核。放开了试，故意踩坑才划算。
        </div>
      </GuideCard>
    </div>
  );
}

/**
 * ② 对话页开局卡：回答「第一句发什么」
 *
 * ★ 考试模式下不显示 ★ 与「考试隐藏六要素清单」同一个道理：
 * 考的是内化，不是照着提示卡打。调用方（DrillClient）传 examMode 进来自己判。
 *
 * ★ 只在第 0 轮显示 ★ 已经聊起来的局再弹「第一句怎么发」是废话，
 * 而且会挡住对话。
 */
export function DrillGuide({ examMode, turn }: { examMode: boolean; turn: number }) {
  const { show, dismiss } = useDismissable(DRILL_KEY);
  if (!show || examMode || turn > 0) return null;

  return (
    <div style={{ marginBottom: 12, flexShrink: 0 }}>
      <GuideCard
        title="这一局怎么打"
        footer={
          <button className="primary" onClick={dismiss}>
            知道了
          </button>
        }
      >
        <div className="small" style={{ lineHeight: 1.85 }}>
          <div>
            <b>· 第一句</b>：打个招呼 + 回应他问的那件事 + <b>抛出你的第一个问题</b>，三样合成一条发出去。
            第一个问题从六要素里挑他最没交代清楚的那项（多半是数量或产品属性）。
          </div>
          <div style={{ marginTop: 6 }}>
            <b>· 每一轮</b>：回答一个问题，<b>必抛一个问题</b>。回完就等着，进程立刻停摆——
            <span style={{ color: 'var(--warn)' }}>连续 3 轮问不出新信息，客户直接走人判负</span>。
          </div>
          <div style={{ marginTop: 6 }}>
            <b>· 看不懂英文</b>：浏览器右键「翻译成中文」。你自己打中文按 <span className="mono">Ctrl+K</span> 译过去。
          </div>
          <div style={{ marginTop: 6 }}>
            <b>· 收尾</b>：六要素问出 4 项以上、该报的价报了，就点「结束并复盘」。
            <span className="faint">聊两三轮就结束会因证据不足不给分；拖满 20 轮算客户跑了。</span>
          </div>
        </div>
      </GuideCard>
    </div>
  );
}

/**
 * ★ GuideButton 已于 2026-08-27 整块删除 ★
 *
 * 它是版头右上角那个 ❓，点开是一个 640px 的弹窗，里面装着
 * 「一局怎么打 / 六要素 / 四条红线 / 报价格式 / 准入规则 / 周考要求」。
 * 内容本身没问题，问题是**它和页面里那些 ? 长得一样，含义却完全不同**——
 * 一个讲「这套系统怎么玩」，一个讲「这个字段什么意思」，
 * 于是一屏上并排挂着六个问号，谁也不知道该点哪个。
 *
 * 现在：内容原样搬进 content/help/basics.tsx，版头那个位置改成一个
 * 指向 /help 的链接（见 AppShell）。**一个帮助入口，一处内容。**
 * 弹窗底部那个「把提示卡放回去」搬到了 /help 最下面，靠下面这个 resetGuideCards。
 */
