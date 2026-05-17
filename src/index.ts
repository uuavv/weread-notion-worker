import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

const WEREAD_API_URL = "https://i.weread.qq.com/api/agent/gateway";
const SKILL_VERSION = "1.0.3";
const PAGE_SIZE = 100;

type JsonRecord = Record<string, unknown>;

type NotebookBook = JsonRecord & {
  bookId?: string;
  book?: WeReadBook;
  reviewCount?: number;
  noteCount?: number;
  bookmarkCount?: number;
  readingProgress?: number;
  markedStatus?: number;
  sort?: number;
};

type WeReadBook = JsonRecord & {
  bookId?: string;
  title?: string;
  author?: string;
  translator?: string;
  cover?: string;
  intro?: string;
  category?: string;
  publisher?: string;
  publishTime?: string;
  isbn?: string;
  wordCount?: number;
  newRating?: number;
  newRatingCount?: number;
};

type Bookmark = JsonRecord & {
  bookmarkId?: string;
  bookId?: string;
  chapterUid?: number;
  markText?: string;
  createTime?: number;
  type?: number;
  range?: string;
  colorStyle?: number;
};

type Chapter = JsonRecord & {
  chapterUid?: number;
  chapterIdx?: number;
  title?: string;
  wordCount?: number;
  level?: number;
  updateTime?: number;
  price?: number;
  paid?: number;
  isMPChapter?: number;
};

type Review = JsonRecord & {
  reviewId?: string;
  content?: string;
  htmlContent?: string;
  abstract?: string;
  bookId?: string;
  chapterUid?: number;
  chapterName?: string;
  createTime?: number;
  range?: string;
  star?: number;
  isFinish?: number;
};

const booksDatabase = worker.database("wereadBooks", {
  type: "managed",
  initialTitle: "WeRead Books",
  primaryKeyProperty: "Book ID",
  schema: {
    properties: {
      Title: Schema.title(),
      "Book ID": Schema.richText(),
      Author: Schema.richText(),
      Translator: Schema.richText(),
      Category: Schema.richText(),
      Publisher: Schema.richText(),
      ISBN: Schema.richText(),
      "Word Count": Schema.number(),
      Rating: Schema.number(),
      "Rating Count": Schema.number(),
      Progress: Schema.number("percent"),
      Status: Schema.select([
        { name: "Reading", color: "blue" },
        { name: "Finished", color: "green" },
        { name: "Unknown", color: "default" },
      ]),
      "Highlight Count": Schema.number(),
      "Review Count": Schema.number(),
      "Bookmark Count": Schema.number(),
      "Read Time Seconds": Schema.number(),
      "Last Read": Schema.date(),
      "Open in WeRead": Schema.url(),
      Cover: Schema.url(),
      Intro: Schema.richText(),
      "Raw JSON": Schema.richText(),
    },
  },
});

const notesDatabase = worker.database("wereadNotes", {
  type: "managed",
  initialTitle: "WeRead Highlights and Notes",
  primaryKeyProperty: "Record ID",
  schema: {
    properties: {
      Text: Schema.title(),
      "Record ID": Schema.richText(),
      Type: Schema.select([
        { name: "Highlight", color: "yellow" },
        { name: "Thought", color: "purple" },
        { name: "Review", color: "blue" },
      ]),
      Book: Schema.relation("wereadBooks", {
        twoWay: true,
        relatedPropertyName: "Notes",
      }),
      Chapter: Schema.richText(),
      "Chapter UID": Schema.number(),
      Range: Schema.richText(),
      Created: Schema.date(),
      "Open Original": Schema.url(),
      Comment: Schema.richText(),
      Rating: Schema.number(),
      "Raw JSON": Schema.richText(),
    },
  },
});

const chaptersDatabase = worker.database("wereadChapters", {
  type: "managed",
  initialTitle: "WeRead Chapters",
  primaryKeyProperty: "Chapter Key",
  schema: {
    properties: {
      Title: Schema.title(),
      "Chapter Key": Schema.richText(),
      Book: Schema.relation("wereadBooks", {
        twoWay: true,
        relatedPropertyName: "Chapters",
      }),
      "Chapter UID": Schema.number(),
      Index: Schema.number(),
      Level: Schema.number(),
      "Word Count": Schema.number(),
      Price: Schema.number(),
      Paid: Schema.select([
        { name: "Paid", color: "green" },
        { name: "Unpaid", color: "red" },
        { name: "Free", color: "default" },
      ]),
      "MP Chapter": Schema.checkbox(),
      Updated: Schema.date(),
      "Open Chapter": Schema.url(),
      "Raw JSON": Schema.richText(),
    },
  },
});

const shelfDatabase = worker.database("wereadShelf", {
  type: "managed",
  initialTitle: "WeRead Shelf",
  primaryKeyProperty: "Shelf Key",
  schema: {
    properties: {
      Name: Schema.title(),
      "Shelf Key": Schema.richText(),
      Type: Schema.select([
        { name: "Book", color: "blue" },
        { name: "Album", color: "purple" },
        { name: "MP", color: "gray" },
        { name: "Archive", color: "yellow" },
      ]),
      Book: Schema.relation("wereadBooks"),
      Author: Schema.richText(),
      Category: Schema.richText(),
      Cover: Schema.url(),
      Secret: Schema.checkbox(),
      Top: Schema.checkbox(),
      Finished: Schema.checkbox(),
      "Read Updated": Schema.date(),
      "Track Count": Schema.number(),
      "Raw JSON": Schema.richText(),
    },
  },
});

const statsDatabase = worker.database("wereadStats", {
  type: "managed",
  initialTitle: "WeRead Reading Stats",
  primaryKeyProperty: "Stats Key",
  schema: {
    properties: {
      Name: Schema.title(),
      "Stats Key": Schema.richText(),
      Mode: Schema.select([
        { name: "weekly", color: "blue" },
        { name: "monthly", color: "green" },
        { name: "annually", color: "yellow" },
        { name: "overall", color: "purple" },
      ]),
      "Base Time": Schema.date(),
      "Read Days": Schema.number(),
      "Total Seconds": Schema.number(),
      "Average Seconds": Schema.number(),
      "Read Rate": Schema.number(),
      "Raw JSON": Schema.richText(),
    },
  },
});

const wereadPacer = worker.pacer("wereadApi", {
  allowedRequests: 60,
  intervalMs: 60_000,
});

worker.sync("wereadOpenApiSync", {
  database: notesDatabase,
  mode: "replace",
  schedule: (process.env.SYNC_SCHEDULE ?? "6h") as "6h",
  execute: async () => {
    const changes: JsonRecord[] = [];
    const [notebooks, shelf, stats] = await Promise.all([
      fetchAllNotebooks(),
      fetchShelf(),
      fetchReadingStats(),
    ]);

    changes.push(...buildShelfChanges(shelf));
    changes.push(...stats.map(buildStatsChange));

    const knownBooks = collectKnownBooks(notebooks, shelf);

    for (const [bookId, seed] of knownBooks) {
      const [bookInfo, progress, chapterResult, bookmarkResult, reviews] = await Promise.all([
        fetchBookInfo(bookId),
        fetchProgress(bookId),
        fetchChapters(bookId),
        fetchBookmarks(bookId),
        fetchAllReviews(bookId),
      ]);

      const book = { ...seed, ...bookInfo, bookId };
      const notebook = notebooks.find((item) => (item.bookId ?? item.book?.bookId) === bookId);
      changes.push(buildBookChange(bookId, book, notebook, progress));

      const chapters = mapChapters(chapterResult.chapters);
      changes.push(...chapterResult.chapters.map((chapter) => buildChapterChange(bookId, chapter)));

      for (const bookmark of bookmarkResult.bookmarks) {
        const record = buildBookmarkChange(bookId, book, bookmark, chapters);
        if (record) changes.push(record);
      }

      for (const review of reviews) {
        const record = buildReviewChange(bookId, book, review);
        if (record) changes.push(record);
      }
    }

    return { changes: changes as never, hasMore: false };
  },
});

function buildBookChange(
  bookId: string,
  book: WeReadBook,
  notebook?: NotebookBook,
  progress?: JsonRecord,
) {
  const progressBook = objectAt(progress, "book");
  const title = safeText(book.title, `WeRead ${bookId}`);
  return {
    type: "upsert" as const,
    targetDatabaseKey: "wereadBooks",
    key: bookId,
    properties: {
      Title: Builder.title(title),
      "Book ID": Builder.richText(bookId),
      Author: Builder.richText(safeText(book.author)),
      Translator: Builder.richText(safeText(book.translator)),
      Category: Builder.richText(safeText(book.category)),
      Publisher: Builder.richText(safeText(book.publisher)),
      ISBN: Builder.richText(safeText(book.isbn)),
      "Word Count": Builder.number(toNumber(book.wordCount)),
      Rating: Builder.number(toNumber(book.newRating)),
      "Rating Count": Builder.number(toNumber(book.newRatingCount)),
      Progress: Builder.number(normalizeProgress(numberAt(progressBook, "progress") ?? notebook?.readingProgress)),
      Status: Builder.select(statusFor(notebook?.markedStatus, numberAt(progressBook, "progress"))),
      "Highlight Count": Builder.number(toNumber(notebook?.noteCount)),
      "Review Count": Builder.number(toNumber(notebook?.reviewCount)),
      "Bookmark Count": Builder.number(toNumber(notebook?.bookmarkCount)),
      "Read Time Seconds": Builder.number(toNumber(numberAt(progressBook, "recordReadingTime"))),
      "Last Read": buildDate(numberAt(progressBook, "updateTime")),
      "Open in WeRead": Builder.url(openBookUrl(bookId)),
      Cover: Builder.url(safeText(book.cover)),
      Intro: Builder.richText(safeText(book.intro)),
      "Raw JSON": Builder.richText(rawJson({ book, notebook, progress })),
    },
    pageContentMarkdown: [`# ${title}`, "", `[Open in WeRead](${openBookUrl(bookId)})`, "", safeText(book.intro)]
      .filter(Boolean)
      .join("\n"),
  };
}

function buildBookmarkChange(
  bookId: string,
  book: WeReadBook,
  bookmark: Bookmark,
  chapters: Map<number, string>,
) {
  if (!bookmark.bookmarkId || !bookmark.markText) return undefined;
  const chapterName = getChapterName(chapters, bookmark.chapterUid);
  const originalUrl = openRangeUrl(bookId, bookmark.chapterUid, bookmark.range);
  return {
    type: "upsert" as const,
    key: `highlight:${bookmark.bookmarkId}`,
    properties: {
      Text: Builder.title(truncate(bookmark.markText, 180)),
      "Record ID": Builder.richText(`highlight:${bookmark.bookmarkId}`),
      Type: Builder.select("Highlight"),
      Book: [Builder.relation(bookId)],
      Chapter: Builder.richText(chapterName),
      "Chapter UID": Builder.number(toNumber(bookmark.chapterUid)),
      Range: Builder.richText(safeText(bookmark.range)),
      Created: buildDate(bookmark.createTime),
      "Open Original": Builder.url(originalUrl),
      Comment: Builder.richText(""),
      Rating: Builder.number(0),
      "Raw JSON": Builder.richText(rawJson(bookmark)),
    },
    upstreamUpdatedAt: unixToIso(bookmark.createTime),
    pageContentMarkdown: buildNotePageContent({ book, text: bookmark.markText, chapterName, originalUrl }),
  };
}

function buildReviewChange(bookId: string, book: WeReadBook, review: Review) {
  if (!review.reviewId || !review.content) return undefined;
  const originalUrl = openRangeUrl(bookId, review.chapterUid, review.range);
  const type = review.range || review.abstract ? "Thought" : "Review";
  const title = review.abstract || review.content;
  return {
    type: "upsert" as const,
    key: `review:${review.reviewId}`,
    properties: {
      Text: Builder.title(truncate(title, 180)),
      "Record ID": Builder.richText(`review:${review.reviewId}`),
      Type: Builder.select(type),
      Book: [Builder.relation(bookId)],
      Chapter: Builder.richText(safeText(review.chapterName)),
      "Chapter UID": Builder.number(toNumber(review.chapterUid)),
      Range: Builder.richText(safeText(review.range)),
      Created: buildDate(review.createTime),
      "Open Original": Builder.url(originalUrl),
      Comment: Builder.richText(review.content),
      Rating: Builder.number(review.star && review.star > 0 ? review.star : 0),
      "Raw JSON": Builder.richText(rawJson(review)),
    },
    upstreamUpdatedAt: unixToIso(review.createTime),
    pageContentMarkdown: buildNotePageContent({
      book,
      text: review.abstract,
      comment: review.content,
      chapterName: review.chapterName,
      originalUrl,
    }),
  };
}

function buildChapterChange(bookId: string, chapter: Chapter) {
  const chapterUid = toNumber(chapter.chapterUid);
  const key = `${bookId}:${chapterUid}`;
  return {
    type: "upsert" as const,
    targetDatabaseKey: "wereadChapters",
    key,
    properties: {
      Title: Builder.title(safeText(chapter.title, `Chapter ${chapterUid}`)),
      "Chapter Key": Builder.richText(key),
      Book: [Builder.relation(bookId)],
      "Chapter UID": Builder.number(chapterUid),
      Index: Builder.number(toNumber(chapter.chapterIdx)),
      Level: Builder.number(toNumber(chapter.level)),
      "Word Count": Builder.number(toNumber(chapter.wordCount)),
      Price: Builder.number(toNumber(chapter.price)),
      Paid: Builder.select(chapter.price ? (chapter.paid === 1 ? "Paid" : "Unpaid") : "Free"),
      "MP Chapter": Builder.checkbox(chapter.isMPChapter === 1),
      Updated: buildDate(chapter.updateTime),
      "Open Chapter": Builder.url(openChapterUrl(bookId, chapterUid)),
      "Raw JSON": Builder.richText(rawJson(chapter)),
    },
  };
}

function buildShelfChanges(shelf: JsonRecord) {
  const changes: JsonRecord[] = [];
  for (const item of arrayAt(shelf, "books")) {
    const bookId = safeText(item.bookId);
    changes.push({
      type: "upsert",
      targetDatabaseKey: "wereadShelf",
      key: `book:${bookId}`,
      properties: {
        Name: Builder.title(safeText(item.title, bookId)),
        "Shelf Key": Builder.richText(`book:${bookId}`),
        Type: Builder.select("Book"),
        Book: bookId ? [Builder.relation(bookId)] : [],
        Author: Builder.richText(safeText(item.author)),
        Category: Builder.richText(safeText(item.category)),
        Cover: Builder.url(safeText(item.cover)),
        Secret: Builder.checkbox(item.secret === 1),
        Top: Builder.checkbox(item.isTop === 1),
        Finished: Builder.checkbox(item.finishReading === 1),
        "Read Updated": buildDate(numberAt(item, "readUpdateTime")),
        "Track Count": Builder.number(0),
        "Raw JSON": Builder.richText(rawJson(item)),
      },
    });
  }

  for (const item of arrayAt(shelf, "albums")) {
    const album = objectAt(item, "albumInfo");
    const extra = objectAt(item, "albumInfoExtra");
    const albumId = safeText(album.albumId);
    changes.push({
      type: "upsert",
      targetDatabaseKey: "wereadShelf",
      key: `album:${albumId}`,
      properties: {
        Name: Builder.title(safeText(album.name, albumId)),
        "Shelf Key": Builder.richText(`album:${albumId}`),
        Type: Builder.select("Album"),
        Book: [],
        Author: Builder.richText(safeText(album.authorName)),
        Category: Builder.richText(""),
        Cover: Builder.url(safeText(album.cover)),
        Secret: Builder.checkbox(extra.secret === 1),
        Top: Builder.checkbox(extra.isTop === 1),
        Finished: Builder.checkbox(album.finish === 1),
        "Read Updated": buildDate(numberAt(extra, "lectureReadUpdateTime")),
        "Track Count": Builder.number(toNumber(numberAt(album, "trackCount"))),
        "Raw JSON": Builder.richText(rawJson(item)),
      },
    });
  }

  if (shelf.mp && typeof shelf.mp === "object") {
    changes.push({
      type: "upsert",
      targetDatabaseKey: "wereadShelf",
      key: "mp:collections",
      properties: {
        Name: Builder.title("文章收藏"),
        "Shelf Key": Builder.richText("mp:collections"),
        Type: Builder.select("MP"),
        Book: [],
        Author: Builder.richText(""),
        Category: Builder.richText(""),
        Cover: Builder.url(""),
        Secret: Builder.checkbox(true),
        Top: Builder.checkbox(false),
        Finished: Builder.checkbox(false),
        "Read Updated": Builder.richText(""),
        "Track Count": Builder.number(0),
        "Raw JSON": Builder.richText(rawJson(shelf.mp)),
      },
    });
  }

  for (const archive of arrayAt(shelf, "archive")) {
    const name = safeText(archive.name, "Archive");
    changes.push({
      type: "upsert",
      targetDatabaseKey: "wereadShelf",
      key: `archive:${name}`,
      properties: {
        Name: Builder.title(name),
        "Shelf Key": Builder.richText(`archive:${name}`),
        Type: Builder.select("Archive"),
        Book: [],
        Author: Builder.richText(""),
        Category: Builder.richText(""),
        Cover: Builder.url(""),
        Secret: Builder.checkbox(false),
        Top: Builder.checkbox(false),
        Finished: Builder.checkbox(false),
        "Read Updated": Builder.richText(""),
        "Track Count": Builder.number(0),
        "Raw JSON": Builder.richText(rawJson(archive)),
      },
    });
  }

  return changes;
}

function buildStatsChange(item: JsonRecord) {
  const mode = safeText(item.mode, "monthly");
  const baseTime = numberAt(item, "baseTime");
  const key = `${mode}:${baseTime ?? 0}`;
  return {
    type: "upsert" as const,
    targetDatabaseKey: "wereadStats",
    key,
    properties: {
      Name: Builder.title(`${mode} reading stats`),
      "Stats Key": Builder.richText(key),
      Mode: Builder.select(mode),
      "Base Time": buildDate(baseTime),
      "Read Days": Builder.number(toNumber(numberAt(item, "readDays"))),
      "Total Seconds": Builder.number(toNumber(numberAt(item, "totalReadTime"))),
      "Average Seconds": Builder.number(toNumber(numberAt(item, "dayAverageReadTime"))),
      "Read Rate": Builder.number(toNumber(numberAt(item, "readRate"))),
      "Raw JSON": Builder.richText(rawJson(item)),
    },
  };
}

async function fetchAllNotebooks(): Promise<NotebookBook[]> {
  const books: NotebookBook[] = [];
  let lastSort: number | undefined;
  for (;;) {
    const body: JsonRecord = { api_name: "/user/notebooks", count: PAGE_SIZE };
    if (lastSort !== undefined) body.lastSort = lastSort;
    const result = await wereadRequest<{ books?: NotebookBook[]; hasMore?: number }>(body);
    const pageBooks = result.books ?? [];
    books.push(...pageBooks);
    if (!result.hasMore || pageBooks.length === 0) return books;
    lastSort = pageBooks.at(-1)?.sort;
    if (lastSort === undefined) return books;
  }
}

async function fetchShelf() {
  return wereadRequest<JsonRecord>({ api_name: "/shelf/sync" });
}

async function fetchBookInfo(bookId: string) {
  return wereadRequest<WeReadBook>({ api_name: "/book/info", bookId }).catch(() => ({}));
}

async function fetchProgress(bookId: string) {
  return wereadRequest<JsonRecord>({ api_name: "/book/getprogress", bookId }).catch(() => ({}));
}

async function fetchChapters(bookId: string) {
  return wereadRequest<{ chapters?: Chapter[] }>({ api_name: "/book/chapterinfo", bookId })
    .then((result) => ({ chapters: result.chapters ?? [] }))
    .catch(() => ({ chapters: [] }));
}

async function fetchBookmarks(bookId: string) {
  return wereadRequest<{ updated?: Bookmark[]; chapters?: Chapter[] }>({
    api_name: "/book/bookmarklist",
    bookId,
  })
    .then((result) => ({ bookmarks: result.updated ?? [], chapters: result.chapters ?? [] }))
    .catch(() => ({ bookmarks: [], chapters: [] }));
}

async function fetchAllReviews(bookId: string): Promise<Review[]> {
  const reviews: Review[] = [];
  let synckey = 0;
  for (;;) {
    const result = await wereadRequest<{
      reviews?: Array<{ review?: Review } | Review>;
      hasMore?: number;
      synckey?: number;
    }>({ api_name: "/review/list/mine", bookid: bookId, count: PAGE_SIZE, synckey }).catch(() => undefined);
    if (!result) return reviews;
    const pageReviews = (result.reviews ?? [])
      .map((item) => ("review" in item ? item.review : item))
      .filter((item): item is Review => Boolean(item));
    reviews.push(...pageReviews);
    if (!result.hasMore || pageReviews.length === 0) return reviews;
    synckey = result.synckey ?? synckey;
  }
}

async function fetchReadingStats(): Promise<JsonRecord[]> {
  const modes = ["weekly", "monthly", "annually", "overall"];
  const results = await Promise.all(
    modes.map((mode) =>
      wereadRequest<JsonRecord>({ api_name: "/readdata/detail", mode }).then((result) => ({ ...result, mode })),
    ),
  );
  return results;
}

async function wereadRequest<T>(body: JsonRecord): Promise<T> {
  const apiKey = process.env.WEREAD_API_KEY;
  if (!apiKey) throw new Error("Missing WEREAD_API_KEY environment variable.");
  await wereadPacer.wait();
  const response = await fetch(WEREAD_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, skill_version: SKILL_VERSION }),
  });
  if (!response.ok) throw new Error(`WeRead API failed with HTTP ${response.status}.`);
  const json = (await response.json()) as JsonRecord;
  if (json.upgrade_info) throw new Error(`WeRead skill needs upgrade: ${JSON.stringify(json.upgrade_info)}`);
  if (typeof json.errcode === "number" && json.errcode !== 0) {
    throw new Error(`WeRead API error ${json.errcode}: ${safeText(json.errmsg)}`);
  }
  return json as T;
}

function collectKnownBooks(
  notebooks: NotebookBook[],
  shelf: JsonRecord,
): Map<string, WeReadBook> {
  const result = new Map<string, WeReadBook>();
  for (const notebook of notebooks) {
    const book = notebook.book ?? {};
    const bookId = notebook.bookId ?? book.bookId;
    if (bookId) result.set(bookId, { ...book, bookId });
  }
  for (const item of arrayAt(shelf, "books")) {
    const bookId = safeText(item.bookId);
    if (bookId && !result.has(bookId)) result.set(bookId, item as WeReadBook);
  }
  return result;
}

function buildNotePageContent(input: {
  book: WeReadBook;
  text?: string;
  comment?: string;
  chapterName?: string;
  originalUrl: string;
}) {
  return [
    `Book: ${safeText(input.book.title)}`,
    input.book.author ? `Author: ${input.book.author}` : "",
    input.chapterName ? `Chapter: ${input.chapterName}` : "",
    "",
    input.text ? `> ${input.text.replaceAll("\n", "\n> ")}` : "",
    input.comment ? `\nComment:\n${input.comment}` : "",
    input.originalUrl ? `\n[Open original](${input.originalUrl})` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function mapChapters(chapters: Chapter[] | undefined) {
  const result = new Map<number, string>();
  for (const chapter of chapters ?? []) {
    if (typeof chapter.chapterUid === "number" && chapter.title) result.set(chapter.chapterUid, chapter.title);
  }
  return result;
}

function getChapterName(chapters: Map<number, string>, chapterUid?: number) {
  return chapterUid === undefined ? "" : chapters.get(chapterUid) ?? "";
}

function openBookUrl(bookId: string) {
  return `weread://reading?bId=${encodeURIComponent(bookId)}`;
}

function openChapterUrl(bookId: string, chapterUid: number) {
  return `weread://reading?bId=${encodeURIComponent(bookId)}&chapterUid=${encodeURIComponent(String(chapterUid))}`;
}

function openRangeUrl(bookId: string, chapterUid?: number, range?: string) {
  const parsedRange = parseRange(range);
  if (chapterUid === undefined || !parsedRange) return openBookUrl(bookId);
  return [
    "weread://bestbookmark",
    `?bookId=${encodeURIComponent(bookId)}`,
    `&chapterUid=${encodeURIComponent(String(chapterUid))}`,
    `&rangeStart=${encodeURIComponent(parsedRange.start)}`,
    `&rangeEnd=${encodeURIComponent(parsedRange.end)}`,
  ].join("");
}

function parseRange(range?: string) {
  const match = range?.match(/^(\d+)-(\d+)$/);
  return match ? { start: match[1], end: match[2] } : undefined;
}

function buildDate(unixSeconds?: number) {
  const date = unixToIso(unixSeconds)?.slice(0, 10);
  return date ? Builder.date(date) : Builder.richText("");
}

function unixToIso(unixSeconds?: number) {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : undefined;
}

function normalizeProgress(progress?: number) {
  if (typeof progress !== "number" || Number.isNaN(progress)) return 0;
  return Math.max(0, Math.min(100, progress)) / 100;
}

function statusFor(markedStatus?: number, progress?: number) {
  if (markedStatus === 1 || progress === 100) return "Finished";
  if (markedStatus === 0 || (progress !== undefined && progress > 0)) return "Reading";
  return "Unknown";
}

function toNumber(value?: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeText(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function rawJson(value: unknown) {
  return truncate(JSON.stringify(value), 1900);
}

function objectAt(value: unknown, key: string): JsonRecord {
  if (!value || typeof value !== "object") return {};
  const child = (value as JsonRecord)[key];
  return child && typeof child === "object" && !Array.isArray(child) ? (child as JsonRecord) : {};
}

function arrayAt(value: unknown, key: string): JsonRecord[] {
  if (!value || typeof value !== "object") return [];
  const child = (value as JsonRecord)[key];
  return Array.isArray(child) ? (child.filter((item) => item && typeof item === "object") as JsonRecord[]) : [];
}

function numberAt(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const child = (value as JsonRecord)[key];
  return typeof child === "number" && Number.isFinite(child) ? child : undefined;
}
