/**
 * 演习场景具象化锚点（需求 9.3）
 *
 * ★ 锚点是配置，不是代码 ★
 * Gate 0 / Gate 4 调标尺时只改这个文件，不动任何逻辑。
 * 这也是「先造机器、最后校尺子」返工成本接近零的原因。
 *
 * ★ 改锚点的纪律（因果卡 CW0804-1）★
 * 人机分数差 ≥2 分时，先查系统引的原话能不能在记录里逐字对上：
 *   对不上 → 取证问题，**不许动锚点**，靠 verifyEvidence 解决；
 *   对得上但判档不同 → 才是锚点问题，改这里，并往 Calibration 表加一条判例。
 */

import type { Force } from '../../engine/types';

export interface AnchorSet {
  label: string;
  /** 分值 → 具象锚点描述 */
  levels: Partial<Record<1 | 2 | 3 | 4 | 5, string>>;
  /** 何时判 NA */
  naWhen?: string;
}

export const INQUIRY_ANCHORS: Partial<Record<Force, AnchorSet>> = {
  insight: {
    label: '洞察力（探需局 30%）',
    levels: {
      1: '六要素 0–1 项，或触发红线①（数量未确认即报价）',
      2: '六要素 2 项；照本宣科，不看客户已给的信息',
      3: '六要素 3–4 项；属性未踩到底，或数量未分属性确认',
      4: '六要素 5–6 项，属性踩到底且数量分属性确认；报价数量与真实数量一致',
      5: '在 4 分基础上，至少解锁 1 张暗牌（识破虚报数量／问出真实用途／识破背调错误并验证出真实身份）',
    },
  },
  guidance: {
    label: '引导力（20%）',
    levels: {
      1: '客户问一句答一句，全程未主动抛问题',
      3: '多数回合有抛问题，能把跑偏的话题拉回来',
      5: '每回合做到"回答一个问题、抛一个问题"；参数问题给选择题；客户不答时不纠缠、换角度继续推',
    },
  },
  solution: {
    label: '方案力（15%）',
    levels: {
      1: '客户提出障碍（没货代、赶时间、清关难）时只解释或干等',
      3: '给出方案，但换个客户原样发送仍然成立（模板话术）',
      5: '方案明确引用该客户已暴露的信息，并给出可执行的下一步（按到货时间倒推付款截止日、按国家主动问清关能力）',
    },
  },
  trust: {
    label: '信任力（10%）',
    levels: {
      1: '只有形容词；或大额订单只回一行字；或拿错误的背调结论去质问客户',
      3: '报价格式合规；提供可见事实（库存、装箱、实物图）',
      5: '3 分基础上有确认+肯定、有情绪表达（不像机器人）、提问包利他外壳',
    },
  },
  closing: {
    label: '闭环力（10%）',
    levels: {
      1: '发完就等；结尾只有 "please check / let me know"；或空催',
      3: '多数沟通留有具体下一步',
      5: '下一步需要客户完成一个关键动作',
    },
  },
  negotiation: {
    label: '博弈力（探需 5%）',
    levels: {
      1: '客户一要价就报，或只会硬顶',
      3: '稳住客户、先收集信息再报价，让步绑定条件',
      5: '把付款、交期、锁价等节点提前摆上桌；每次让步换回一个推进节点',
    },
    naWhen: '人设未激活博弈力（如配合型）时判 NA',
  },
  stability: {
    label: '稳定力（10%）',
    levels: {
      1: '连环催单、哀求，或客户沉默后直接放弃',
      3: '不催不慌，但变成被动等待',
      5: '沉默期用价值内容重新启动；四级用尽仍体面收尾、留住关系',
    },
    naWhen: '探需局判 NA；跟进局激活',
  },
};

export function renderAnchors(activeForces: Force[], naForces: Force[]): string {
  const lines: string[] = [];
  for (const [force, set] of Object.entries(INQUIRY_ANCHORS) as [Force, AnchorSet][]) {
    if (naForces.includes(force)) {
      lines.push(`【${set.label}】本局判 NA：${set.naWhen ?? '本人设不激活'}`);
      continue;
    }
    if (!activeForces.includes(force)) continue;
    lines.push(`【${set.label}】`);
    for (const [score, desc] of Object.entries(set.levels)) lines.push(`${score} 分：${desc}`);
    lines.push('');
  }
  return lines.join('\n');
}
