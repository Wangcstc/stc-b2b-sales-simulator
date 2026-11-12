# 应用镜像。配合 docker-compose.prod.yml 使用
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
# postinstall 会顺带 prisma generate（schema 已在上一行拷进来）
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# ★ 整个项目一起带上 ★ 除了网站本身，部署说明里还要在容器里跑 `npm run seed`、`npm run bank -- load`，
# 它们要用 scripts/、src/lib/、bank-kit/、engine/、standards/、samples/。只挑几个目录拷，少一个就在上线当天报错。
COPY --from=builder /app ./
EXPOSE 3100
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
