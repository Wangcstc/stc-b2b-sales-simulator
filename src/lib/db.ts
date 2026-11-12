import { PrismaClient } from '@prisma/client';

// Next dev 模式热重载会反复 new，挂到 global 上避免连接数爆掉
const g = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  g.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') g.prisma = prisma;
