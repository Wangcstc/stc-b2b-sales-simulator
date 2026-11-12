-- 身份枚举新增「管理员」。
--
-- ★ 为什么单独一条迁移只做 ADD VALUE ★
-- PostgreSQL 不允许在同一个事务里「新增枚举值」并「使用该值」。
-- 所以这里只加值；把现有主管账号纠正为 MANAGER 的那一步放在 seed-core，
-- 每次 npm run seed 都会自动对齐，重灌库也不会再错。
ALTER TYPE "EmployeeType" ADD VALUE IF NOT EXISTS 'MANAGER';
