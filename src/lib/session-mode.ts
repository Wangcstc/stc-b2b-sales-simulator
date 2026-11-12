export type SupportedSessionMode = 'DRILL' | 'EXAM' | 'ADMISSION_EXAM';

export function isExamSession(mode: string): boolean {
  return mode === 'EXAM' || mode === 'ADMISSION_EXAM';
}

export function sessionModeLabel(mode: string): string {
  if (mode === 'EXAM') return '历史考试';
  if (mode === 'ADMISSION_EXAM') return '准入考试';
  return '演习';
}
