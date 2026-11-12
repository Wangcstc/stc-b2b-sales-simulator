'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { changeMyPassword } from '@/app/team/password-action';

/**
 * 改自己的口令。**弹窗，不是页面上的一块。**
 *
 * ★ 为什么是弹窗 ★ 它先是一整页（/account），撤掉之后落成账号管理页最下面的一块。
 * 可这件事一年做不了几次，却常年占着一屏的位置，还把「主管改过我的期别」
 * 那些真要看的内容往下推。弹窗只在点的时候存在，平时零占地。
 *
 * ★ 用原生 <dialog> + showModal()，不用 CSS 假弹窗 ★
 * 它自带三件事，而这三件对一个口令表单都不是可选项：
 *   ① 焦点陷阱——Tab 不会跑到背后的表格里去，不然填口令时按两下 Tab 就失焦了；
 *   ② Esc 关闭——不用去找关闭按钮；
 *   ③ 背景 inert + ::backdrop——背后的东西点不到，也不会被读屏软件念出来。
 * 表格里那套 checkbox + :has() 的纯 CSS 展开在这儿不够用：它给不了焦点管理。
 *
 * ★ 服务端动作出错要把弹窗重新打开 ★
 * `changeMyPassword` 校验失败会 redirect 回来带上 ?pwErr=，那是一次真实导航，
 * 弹窗早就随着页面重建关掉了。所以挂载时看到 pwErr / pwOk 就自动开——
 * 否则用户点了保存，页面闪一下，什么反馈都没有。
 *
 * ★ 弹窗必须 portal 到 body，不能留在原地 ★（2026-08-26 修）
 * 主管那个触发按钮长在账号一览的 `<td class="cell-ops">` 里。showModal() 会把
 * <dialog> 提到顶层图层，**但那只改渲染位置，不改 DOM 归属**——它在 DOM 上仍然是
 * 那个 td 的后代，于是两条路一起漏：
 *   ① 继承属性照常往下传：`.cell-ops` 的 white-space:nowrap 和 text-align:right
 *      直接落到弹窗里，说明文字不折行、内容全靠右；
 *   ② 后代选择器照常命中：`.team-table form { display: inline }` 的权重（0,1,1）
 *      压过 `.pw-form { display: grid }`（0,1,0），表单直接塌掉，
 *      三个输入框挤成一行、表单撑到 766px 把 440px 的白框顶破。
 * 逐条提权是打地鼠——`.team-table.roster` 底下几十条规则，今天补完明天加一条又漏。
 * portal 到 body 之后弹窗不再是表格的后代，这两条路一起断掉。
 * 业务员那个看着正常，只是因为它恰好没落在表格里——同一个隐患，不是两种情况。
 */
export default function ChangePassword({
  error,
  ok,
  className = 'row-edit-btn',
  children = '改口令',
}: {
  error?: string;
  ok?: string;
  /** 触发按钮的样式类，默认跟表格里的「编辑」同一款 */
  className?: string;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // portal 要等到浏览器里才有 document.body：服务端渲染阶段先不出这一段
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (mounted && (error || ok) && ref.current && !ref.current.open) ref.current.showModal();
  }, [mounted, error, ok]);

  const dialog = (
    <dialog ref={ref} className="modal" aria-labelledby="pw-title">
        {/*
          点背景关闭。★ 判据是「点到的是 dialog 本身」★ <dialog> 的盒子铺满整个视口，
          里面那层 .modal-body 才是看得见的白框；所以点在框外时 e.target 是 dialog，
          点在框内时是 .modal-body 或它的子元素。不这么判的话，点表单里任何地方都会关窗。
        */}
        <div
          className="modal-scrim"
          onClick={(e) => {
            if (e.target === e.currentTarget) ref.current?.close();
          }}
        >
          <div className="modal-body">
            <div className="modal-head">
              <b id="pw-title">改口令</b>
              <button
                type="button"
                className="modal-x"
                onClick={() => ref.current?.close()}
                aria-label="关闭"
              >
                ✕
              </button>
            </div>

            {error && (
              <div className="card small" style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}>
                {error}
              </div>
            )}
            {ok && (
              <div className="card small" style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}>
                口令已更新。
              </div>
            )}

            <form action={changeMyPassword} className="pw-form">
              <div>
                <label>当前口令</label>
                <input name="current" type="password" required autoComplete="current-password" />
              </div>
              <div>
                <label>新口令（至少 6 位，别用纯数字）</label>
                <input name="next" type="password" required autoComplete="new-password" />
              </div>
              <div>
                <label>再输一遍</label>
                <input name="confirm" type="password" required autoComplete="new-password" />
              </div>

              <div className="pw-form-foot">
                <button className="primary" type="submit">
                  保存
                </button>
                <button type="button" className="ghost" onClick={() => ref.current?.close()}>
                  取消
                </button>
              </div>

              <p className="tiny faint" style={{ margin: 0 }}>
                要先输一遍当前口令——不然别人趁你没锁屏就能把你的号改走。
                真忘了旧口令，找主管重置：重置＝清空，你下次登录时自己再设一个。
              </p>
            </form>
          </div>
        </div>
      </dialog>
  );

  return (
    <>
      <button type="button" className={className} onClick={() => ref.current?.showModal()}>
        {children}
      </button>
      {mounted && createPortal(dialog, document.body)}
    </>
  );
}
