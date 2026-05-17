# 微信读书 Notion Worker

这个项目用于把微信读书 Skill API 中属于你个人账号的数据同步到 Notion Worker 托管数据库。

## 会创建什么

- `WeRead Books`：书籍主表，包含书名、作者、阅读进度、笔记统计、评分、封面和微信读书跳转链接。
- `WeRead Highlights and Notes`：划线、想法、个人评论，并通过关系字段关联到对应书籍。
- `WeRead Chapters`：章节目录，包含章节 UID、层级、字数、付费状态和章节跳转链接。
- `WeRead Shelf`：书架条目，包含电子书、专辑/有声书、文章收藏入口和书单归档。
- `WeRead Reading Stats`：本周、本月、本年、总计四类阅读统计。

多数数据库都包含 `Raw JSON` 字段，用来保存 API 返回的原始数据片段，避免字段遗漏。每条笔记都会保存一个 `weread://` 深度链接。具备 `chapterUid` 和 `range` 的划线或想法，可以从 Notion 跳回微信读书 App 的原文位置；无法定位到具体位置的整本书评论，会回退为打开对应书籍。

## 使用前提

- 你已经有 Notion Worker 同步服务的部署流程。
- 你已经有微信读书 API Key，格式类似 `wrk-...`。
- 运行环境需要 Node.js 22 或更高版本。

## 安装

安装项目依赖：

```bash
npm install
```

## 配置

把微信读书 API Key 配置为 Notion Worker 的环境变量：

```bash
notion workers env set WEREAD_API_KEY
```

可选：配置同步频率：

```bash
notion workers env set SYNC_SCHEDULE
```

常用示例：

```text
30m
6h
1d
```

如果不配置 `SYNC_SCHEDULE`，默认每 6 小时同步一次。

## 部署

使用你现有的 Notion Worker 部署流程部署即可。部署后，Worker 会创建并维护两张托管数据库：

- `WeRead Books`
- `WeRead Highlights and Notes`

## 本地检查

运行类型检查：

```bash
npm run typecheck
```

## 同步范围

当前同步内容包括：

- 书架：电子书、专辑/有声书、文章收藏入口、归档书单
- 书籍：详情、进度、评分、统计字段
- 章节：目录、层级、字数、付费状态
- 笔记：划线原文、个人想法、整本书评论
- 阅读统计：本周、本月、本年、总计
- 原始数据：核心记录保留 `Raw JSON`
- 跳转链接：跳回微信读书原文、章节或书籍的深度链接

不会同步的内容：

- 公开点评，包括其他用户对书籍的评论
- 热门划线、热门划线下的公开想法
- 为你推荐、相似推荐、搜索结果
- 任何不能通过当前 API Key 识别为你个人账号的数据

## 注意事项

- Notion Worker sync 当前会创建和管理自己的数据库，不能直接把同步数据写入你已有的 Notion 数据库。
- 微信读书当前接口不能导出普通书签内容，只能读取书签数量；可导出的内容是划线、想法和评论。
- 项目只调用个人数据相关接口，不调用 `/review/list`、`/book/recommend`、`/book/bestbookmarks`、`/book/readreviews` 等公开或推荐类接口。
- 不要把 `WEREAD_API_KEY` 写入代码或提交到 GitHub。项目里的 `.env.example` 只是占位示例。
