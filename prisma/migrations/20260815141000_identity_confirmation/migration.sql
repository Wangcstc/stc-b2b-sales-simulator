-- v3.0 上线要求历史账号逐一确认身份；不能用 OTHER 默认值猜“已确认”。
ALTER TABLE "User" ADD COLUMN "identityConfirmedAt" TIMESTAMP(3);
