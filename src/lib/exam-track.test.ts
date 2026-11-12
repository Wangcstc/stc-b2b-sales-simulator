/**
 * 考试轨判定的测试。
 *
 * ★ 为什么这 48 行值得单独测 ★
 * 全项目有 12 个文件依赖它——版头、TAB、考试页、训练台、账号管理、结算，
 * 全都拿它的返回值决定「这个人看到什么、能做什么」。它判错一次，
 * 影响面比任何一个页面的 bug 都大，而在 2026-08-25 之前它一个测试都没有。
 *
 * 这里刻意把**四种身份 × 四种参与模式**全排一遍：
 * 这个函数的正确性不在"对的组合返回对的轨"，而在"没列出来的组合一律返回 null"——
 * 也就是宁可不给权限，也不能猜。上一次事故正是身份与参与模式对不上时系统替人猜了一个。
 */

import { describe, expect, it } from 'vitest';
import { examTrackOf, isAdmissionTrack, isWeeklyTrack, TRACK_LABEL } from './exam-track';

const EMPLOYEE_TYPES = ['INTERN', 'REGULAR', 'MANAGER', 'UNCONFIRMED'];
const MODES = ['ADMISSION', 'WEEKLY_EXAM', 'NONE', 'CALIBRATION'];

describe('examTrackOf：他走哪条考试轨', () => {
  it('实习业务员 + 准入模式 → 准入轨', () => {
    expect(examTrackOf({ employeeType: 'INTERN', participationMode: 'ADMISSION' })).toBe('ADMISSION');
  });

  it('正式业务员 + 周考模式 → 周考轨', () => {
    expect(examTrackOf({ employeeType: 'REGULAR', participationMode: 'WEEKLY_EXAM' })).toBe('WEEKLY');
  });

  it('主管不参加考试', () => {
    expect(examTrackOf({ employeeType: 'MANAGER', participationMode: 'NONE' })).toBeNull();
  });

  it('★ 只有两种组合成立，其余 14 种一律 null ★ 对不上就不给，不猜', () => {
    const ok = new Set(['INTERN|ADMISSION', 'REGULAR|WEEKLY_EXAM']);
    for (const employeeType of EMPLOYEE_TYPES) {
      for (const participationMode of MODES) {
        const expected = ok.has(`${employeeType}|${participationMode}`);
        const got = examTrackOf({ employeeType, participationMode });
        expect(
          got !== null,
          `${employeeType} + ${participationMode} 应该${expected ? '有' : '没有'}轨，实际得到 ${got}`,
        ).toBe(expected);
      }
    }
  });

  it('★ 身份与模式错配一律 null ★ 上一次事故就是这种行：身份被手选成正式业务员、模式却是「无」', () => {
    expect(examTrackOf({ employeeType: 'REGULAR', participationMode: 'NONE' })).toBeNull();
    expect(examTrackOf({ employeeType: 'INTERN', participationMode: 'WEEKLY_EXAM' })).toBeNull();
    expect(examTrackOf({ employeeType: 'REGULAR', participationMode: 'ADMISSION' })).toBeNull();
  });

  it('大小写与空白不做兼容——枚举值必须严格相等，模糊匹配会把错配放进来', () => {
    expect(examTrackOf({ employeeType: 'intern', participationMode: 'ADMISSION' })).toBeNull();
    expect(examTrackOf({ employeeType: 'INTERN ', participationMode: 'ADMISSION' })).toBeNull();
    expect(examTrackOf({ employeeType: '', participationMode: '' })).toBeNull();
  });
});

describe('isAdmissionTrack / isWeeklyTrack 与 examTrackOf 永远一致', () => {
  it('两个断言函数不会和主函数说不同的话', () => {
    for (const employeeType of EMPLOYEE_TYPES) {
      for (const participationMode of MODES) {
        const user = { employeeType, participationMode };
        const track = examTrackOf(user);
        expect(isAdmissionTrack(user)).toBe(track === 'ADMISSION');
        expect(isWeeklyTrack(user)).toBe(track === 'WEEKLY');
        // 互斥：不可能同时走两条轨
        expect(isAdmissionTrack(user) && isWeeklyTrack(user)).toBe(false);
      }
    }
  });
});

describe('TRACK_LABEL：界面上不许出现枚举原文', () => {
  it('两条轨都有中文名，且不等于枚举值本身', () => {
    expect(TRACK_LABEL.ADMISSION).toBe('准入训练');
    expect(TRACK_LABEL.WEEKLY).toBe('周考');
    for (const [key, label] of Object.entries(TRACK_LABEL)) {
      expect(label).not.toBe(key);
      expect(label).not.toMatch(/[A-Z_]{4,}/);
    }
  });
});
