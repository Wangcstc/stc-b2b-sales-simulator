-- 工作日历 + 个人请假。只增表，不动任何既有数据。
--
-- ★ 为什么要有这两张表 ★ 判定窗口是「判定日 + 前一个业务日」，而业务日此前
-- 只跳周六周日。国庆、春节这类法定假期在代码眼里是工作日，于是假期里每人每天
-- 都会被判「整天缺考」，假期后还要再连累两天判不出结论。
--
-- BusinessCalendar 只存例外：没记录的日子走默认（周一至周五上班）。
-- isWorkday=false 是放假，isWorkday=true 是调休上班（中国的假期一定带调休）。

CREATE TABLE "BusinessCalendar" (
    "day" TEXT NOT NULL,
    "isWorkday" BOOLEAN NOT NULL,
    "label" TEXT,
    "setBy" TEXT,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessCalendar_pkey" PRIMARY KEY ("day")
);

CREATE INDEX "BusinessCalendar_day_isWorkday_idx" ON "BusinessCalendar"("day", "isWorkday");

CREATE TABLE "LeaveDay" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "reason" TEXT,
    "setBy" TEXT,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveDay_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeaveDay_userId_day_key" ON "LeaveDay"("userId", "day");
CREATE INDEX "LeaveDay_day_idx" ON "LeaveDay"("day");

ALTER TABLE "LeaveDay" ADD CONSTRAINT "LeaveDay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
