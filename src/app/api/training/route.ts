import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { ensureAdmissionTrainingPlan, startTrainingTask } from '@/lib/training';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (user.employeeType !== 'INTERN' || user.participationMode !== 'ADMISSION') {
    return NextResponse.json({ error: '你的账号不在实习业务员准入模式' }, { status: 403 });
  }
  const tasks = await ensureAdmissionTrainingPlan(user.id);
  return NextResponse.json({ tasks });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (user.employeeType !== 'INTERN' || user.participationMode !== 'ADMISSION') {
    return NextResponse.json({ error: '你的账号不在实习业务员准入模式' }, { status: 403 });
  }
  const { taskId } = (await req.json()) as { taskId?: string };
  if (!taskId) return NextResponse.json({ error: '缺少 taskId' }, { status: 400 });
  try {
    const session = await startTrainingTask(user, taskId);
    return NextResponse.json({ sessionId: session.id });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '无法开始任务' }, { status: 409 });
  }
}

