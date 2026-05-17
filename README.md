# 微信读书 Notion Worker

极简稳定版：只同步到一张 Notion Worker 托管数据库。

## 同步数据库

只创建并写入：

- `WeRead Highlights and Notes`

## 同步内容

只保留：

- 微信书架里的书籍名称、作者、bookId
- 个人划线
- 个人想法/点评
- 个人整本书评论

已砍掉：

- 阅读统计
- 章节目录
- 书籍详情扩展字段
- 阅读进度
- 推荐
- 公开点评
- 热门划线
- 多数据库同步

## 配置

必须配置：

```bash
ntn workers env set WEREAD_API_KEY=你的微信读书APIKey
```

建议配置为最稳：

```bash
ntn workers env set BOOKS_PER_EXECUTION=1
ntn workers env set NOTEBOOK_SCAN_PAGES=1
ntn workers env set SYNC_SCHEDULE=6h
```

说明：

- `BOOKS_PER_EXECUTION=1`：每次只处理一本有笔记的书，避免超时。
- `NOTEBOOK_SCAN_PAGES=1`：只扫描最近一页有笔记的书，避免全量巡检。
- `SYNC_SCHEDULE=6h`：每 6 小时同步一次。

## 部署

```bash
git pull
npm install
npm run typecheck
npm run build
ntn workers deploy
ntn workers sync state reset wereadOpenApiSync
```

如果你是重新部署：

```bash
git clone https://github.com/uuavv/weread-notion-worker.git
cd weread-notion-worker
npm install
npm run build
ntn workers deploy --name weread-notion-worker
ntn workers env set WEREAD_API_KEY=你的微信读书APIKey
ntn workers env set BOOKS_PER_EXECUTION=1
ntn workers env set NOTEBOOK_SCAN_PAGES=1
ntn workers env set SYNC_SCHEDULE=6h
ntn workers deploy
```

## 排查

查看运行日志：

```bash
ntn workers runs list
ntn workers runs logs <run-id>
```

如果之前部署过多数据库版本，Notion 里旧的空数据库可以手动删除；当前只需要看 `WeRead Highlights and Notes`。
