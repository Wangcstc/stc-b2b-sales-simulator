import type { Metadata } from 'next';
import Link from 'next/link';
import CopyWechat from './CopyWechat';
import styles from './cooperation.module.css';

export const metadata: Metadata = {
  title: '企业合作',
};

export default function CooperationPage() {
  return (
    <main className={styles.page}>
      <Link href="/" className={styles.back}>
        <span aria-hidden="true">←</span> 返回沙盘
      </Link>

      <header className={styles.heading}>
        <span className="brand-mark" aria-hidden="true" />
        <div>
          <h1>企业合作</h1>
          <p>王铖运营社（STC）</p>
        </div>
      </header>

      <div className={styles.services}>
        <section>
          <h2>企业 AI 部署与定制</h2>
          <p>从具体业务问题入手，梳理现有流程，部署合适的 AI 工具，并按团队的使用场景定制功能。</p>
        </section>
        <section>
          <h2>外贸业务管理 AI 化</h2>
          <p>把询盘处理、客户跟进、新人训练和复盘串进日常工作。让业务员清楚下一步该做什么，让主管看得到进度和需要辅导的地方。</p>
        </section>
        <section>
          <h2>阿里国际站运营诊断与陪跑</h2>
          <p>结合店铺数据和询盘质量，找出商品、流量、推广或询盘承接的卡点，和团队一起排优先级、跟进执行、复盘效果。</p>
        </section>
      </div>

      <CopyWechat />
    </main>
  );
}
