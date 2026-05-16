# 微信读书 Notion Worker

这个项目用于把个人微信读书中的划线、想法、摘录和评论同步到 Notion Worker 托管数据库。

## 会创建什么

- `WeRead Books`：每本书一条记录，包含书名、作者、阅读进度、笔记统计、封面和微信读书跳转链接。
- `WeRead Highlights and Notes`：每条划线、想法或评论一条记录，并通过关系字段关联到对应书籍。

每条笔记都会保存一个 `weread://` 深度链接。具备 `chapterUid` 和 `range` 的划线或想法，可以从 Notion 跳回微信读书 App 的原文位置；无法定位到具体位置的整本书评论，会回退为打开对应书籍。

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

- 有笔记的书籍列表
- 划线原文
- 个人想法和点评
- 整本书评论
- 章节名、位置范围、创建时间
- 跳回微信读书原文或书籍的深度链接

## 注意事项

- Notion Worker sync 当前会创建和管理自己的数据库，不能直接把同步数据写入你已有的 Notion 数据库。
- 微信读书当前接口不能导出普通书签内容，只能读取书签数量；可导出的内容是划线、想法和评论。
- 不要把 `WEREAD_API_KEY` 写入代码或提交到 GitHub。项目里的 `.env.example` 只是占位示例。
