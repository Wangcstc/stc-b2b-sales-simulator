#!/bin/sh
# 数据库每日备份（步骤 51）。演习记录是训练资产，丢了没法重建。
# crontab 里挂：0 3 * * * /app/scripts/backup.sh
set -e
DIR=${BACKUP_DIR:-/backup}
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p "$DIR"
pg_dump "$DATABASE_URL" > "$DIR/drill-$STAMP.sql"
# 只留最近 14 天
find "$DIR" -name 'drill-*.sql' -mtime +14 -delete
echo "备份完成：$DIR/drill-$STAMP.sql"
