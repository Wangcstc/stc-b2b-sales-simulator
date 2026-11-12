-- 登录流水。只增表，不动任何既有数据。
-- ★ 历史登录记录无法回填 ★ 系统此前不记录登录事件，这张表从部署那一刻起才有数据。

CREATE TABLE "LoginEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL DEFAULT 'SIGN_IN',

    CONSTRAINT "LoginEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoginEvent_userId_at_idx" ON "LoginEvent"("userId", "at");
CREATE INDEX "LoginEvent_at_idx" ON "LoginEvent"("at");

ALTER TABLE "LoginEvent" ADD CONSTRAINT "LoginEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
