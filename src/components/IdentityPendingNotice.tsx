/**
 * 身份待确认时首页那一条提示。
 *
 * ★ 2026-08-24 由 V3TaskPanel 收缩而来 ★
 * 那个组件原本一身兼三职：实习业务员的准入训练任务、正式业务员的校准任务、
 * 以及这条提示。前两职已经各自有了专属的卡（`AdmissionPanel` / `WeeklyExamPanel`），
 * 校准任务同日整个删掉，于是 153 行里只剩这一个黄框还会真的渲染。
 *
 * ★ 顺带修掉一处枚举外泄 ★ 老组件在「首轮训练已完成 N/8」那行后面直接拼
 * `identity.inquiryAccessStatus`，页面上会出现 `NOT_APPLICABLE` 这种原文。
 *
 * ★ 系统不猜身份 ★ 历史账号一律落在这里，不默认当成实习业务员——
 * 猜错的后果是把一个正式业务员塞进准入判定，第二天他的询盘就被停了。
 */
export default function IdentityPendingNotice() {
  return (
    <div className="card small section-block" style={{ borderColor: 'var(--warn)' }}>
      账号身份尚未确认。请主管在「账号管理」里把你设成<b>实习业务员</b>或<b>正式业务员</b>——
      在那之前，你可以照常练习，但不会有考试任务。
    </div>
  );
}
