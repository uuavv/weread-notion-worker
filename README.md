# 微信读书 Notion Worker

这个项目把微信读书 Skill API 中属于你个人账号的数据同步到一个 Notion Worker 托管数据库。

## 当前设计

为避免 Notion Worker 跨数据库同步不稳定，当前版本只创建一张数据库：

- `WeRead Personal Sync`

所有记录通过 `Type` 字段区分：

- `Sync Status`：同步状态和错误信息
- `Book`：个人有笔记的书籍详情和阅读进度
- `Shelf Book`：书架中的电子书
- `Shelf Album`：书架中的专辑/有声书
- `Shelf MP`：文章收藏入口
- `Shelf Archive`：书架归档/书单
- `Reading Stat`：本周、本月、本年、总计阅读统计
- `Chapter`：章节目录
- `Highlight`：个人划线
- `Thought`：个人划线想法
- `Review`：个人整本书评论

核心记录会保存 `Raw JSON` 字段，尽量保留微信读书 API 返回的原始信息。

## 不会同步的内容

- 其他用户的公开点评
- 热门划线
- 热门划线下的公开想法
- 为你推荐、相似推荐、搜索结果
- 普通书签内容。微信读书当前接口只提供书签数量，不导出书签正文。

## 配置

必须配置微信读书 API Key：

```bash
ntn workers env set WEREAD_API_KEY=你的微信读书APIKey
```

可选：同步频率，默认 `6h`：

```bash
ntn workers env set SYNC_SCHEDULE=6h
```

可选：每次执行处理几本书，默认 `2`。如果 Worker 超时，设为 `1`：

```bash
ntn workers env set BOOKS_PER_EXECUTION=1
```

可选：每次扫描最近几页有笔记的书，默认 `1`，每页最多 100 本：

```bash
ntn workers env set NOTEBOOK_SCAN_PAGES=1
```

## 部署

```bash
git pull
npm install
npm run typecheck
npm run build
ntn workers deploy
ntn workers sync state reset wereadOpenApiSync
```

如果你是删除旧 Worker 后重新部署：

```bash
git clone https://github.com/uuavv/weread-notion-worker.git
cd weread-notion-worker
npm install
npm run build
ntn workers deploy --name weread-notion-worker
ntn workers env set WEREAD_API_KEY=你的微信读书APIKey
ntn workers env set BOOKS_PER_EXECUTION=1
ntn workers env set NOTEBOOK_SCAN_PAGES=1
ntn workers deploy
```

## 排查

查看 Worker 运行：

```bash
ntn workers runs list
ntn workers runs logs <run-id>
```

如果数据库有 `Sync Status - Errors`，打开这条记录的 `Raw JSON` 或 `Comment` 字段查看失败接口。
