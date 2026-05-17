import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

const WEREAD_API_URL = "https://i.weread.qq.com/api/agent/gateway";
const SKILL_VERSION = "1.0.3";
const PAGE_SIZE = 100;
const BOOKS_PER_EXECUTION = numberEnv("BOOKS_PER_EXECUTION", 2);
const NOTEBOOK_SCAN_PAGES = numberEnv("NOTEBOOK_SCAN_PAGES", 1);
const ERROR_TEXT_LIMIT = 500;

type JsonRecord = Record<string, unknown>;

type SyncState = {
  entries: BookEntry[];
  index: number;
  errors: string[];
};

type BookEntry = {
  bookId: string;
  seed: WeReadBook;
  notebook?: NotebookBook;
};

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
  isbn?: string;
  wordCount?: number;
  newRating?: number;
  newRatingCount?: number;
};

type Bookmark = JsonRecord & {
  bookmarkId?: string;
  chapterUid?: number;
  markText?: string;
  createTime?: number;
  range?: string;
};

type Chapter = JsonRecord & {
  chapterUid?: number;
  chapterIdx?: number;
  title?: string;
  wordCount?: number;
  level?: number;
  updateTime?: number;
};

type Review = JsonRecord & {
  reviewId?: string;
  content?: string;
  abstract?: string;
  chapterUid?: number;
  chapterName?: string;
  createTime?: number;
  range?: string;
  star?: number;
};

const recordsDatabase = worker.database("wereadRecords", {
  type: "managed",
  initialTitle: "WeRead Personal Sync",
  primaryKeyProperty: "Record ID",
  schema: {
    properties: {
      Title: Schema.title(),
      "Record ID": Schema.richText(),
      Type: Schema.select([
        { name: "Sync Status", color: "gray" },
        { name: "Book", color: "blue" },
        { name: "Shelf Book", color: "blue" },
        { name: "Shelf Album", color: "purple" },
        { name: "Shelf MP", color: "gray" },
        { name: "Shelf Archive", color: "yellow" },
        { name: "Reading Stat", color: "green" },
        { name: "Chapter", color: "default" },
        { name: "Highlight", color: "yellow" },
        { name: "Thought", color: "purple" },
        { name: "Review", color: "orange" },
      ]),
      "Book ID": Schema.richText(),
      Book: Schema.richText(),
      Author: Schema.richText(),
      Chapter: Schema.richText(),
      "Chapter UID": Schema.number(),
      Range: Schema.richText(),
      Created: Schema.date(),
      Progress: Schema.number("percent"),
      Count: Schema.number(),
      Rating: Schema.number(),
      URL: Schema.url(),
      Text: Schema.richText(),
      Comment: Schema.richText(),
      "Raw JSON": Schema.richText(),
    },
  },
});

const wereadPacer = worker.pacer("wereadApi", {
  allowedRequests: 60,
  intervalMs: 60_000,
});

worker.sync("wereadOpenApiSync", {
  database: recordsDatabase,
  mode: "replace",
  schedule: (process.env.SYNC_SCHEDULE ?? "6h") as "6h",
  execute: async (state: SyncState | undefined) => {
    const changes: JsonRecord[] = [];
    const errors = [...(state?.errors ?? [])];
    let entries = state?.entries;
    let index = state?.index ?? 0;

    if (!entries) {
      const notebooks = await fetchRecentNotebooks(NOTEBOOK_SCAN_PAGES).catch((error: unknown) => {
        errors.push(`notebooks: ${errorMessage(error)}`);
        return [] as NotebookBook[];
      });
      const shelf = await fetchShelf().catch((error: unknown) => {
        errors.push(`shelf: ${errorMessage(error)}`);
        return {} as JsonRecord;
      });
      const stats = await fetchReadingStats(errors);

      changes.push(...buildShelfRecords(shelf));
      changes.push(...stats.map(buildStatsRecord));
      entries = collectBookEntries(notebooks);
      changes.push(buildStatusRecord(entries.length, 0, errors, false));
    }

    const batch = entries.slice(index, index + BOOKS_PER_EXECUTION);
    for (const entry of batch) {
      const { bookId, seed, notebook } = entry;
      const [bookInfo, progress, chapterResult, bookmarkResult, reviews] = await Promise.all([
        fetchBookInfo(bookId),
        fetchProgress(bookId),
        fetchChapters(bookId),
        fetchBookmarks(bookId),
        fetchAllReviews(bookId),
      ]);

      const book = { ...seed, ...bookInfo, bookId };
      changes.push(buildBookRecord(bookId, book, notebook, progress));

      const chapters = mapChapters(chapterResult.chapters);
      changes.push(...chapterResult.chapters.map((chapter) => buildChapterRecord(bookId, book, chapter)));

      for (const bookmark of bookmarkResult.bookmarks) {
        const record = buildBookmarkRecord(bookId, book, bookmark, chapters);
        if (record) changes.push(record);
      }

      for (const review of reviews) {
        const record = buildReviewRecord(bookId, book, review);
        if (record) changes.push(record);
      }
    }

    index += batch.length;
    const hasMore = index < entries.length;
    changes.push(buildStatusRecord(entries.length, index, errors, !hasMore));

    return {
      changes: changes as never,
      hasMore,
      nextState: hasMore ? { entries, index, errors } : undefined,
    };
  },
});

function buildStatusRecord(total: number, processed: number, errors: string[], done: boolean) {
  return upsert("sync:status", {
    Title: Builder.title(errors.length ? "Sync Status - Errors" : "Sync Status - OK"),
    "Record ID": Builder.richText("sync:status"),
    Type: Builder.select("Sync Status"),
    "Book ID": Builder.richText(""),
    Book: Builder.richText(""),
    Author: Builder.richText(""),
    Chapter: Builder.richText(""),
    "Chapter UID": Builder.number(0),
    Range: Builder.richText(""),
    Created: Builder.date(new Date().toISOString().slice(0, 10)),
    Progress: Builder.number(total > 0 ? processed / total : 1),
    Count: Builder.number(errors.length),
    Rating: Builder.number(0),
    URL: Builder.url(""),
    Text: Builder.richText(`Processed ${processed}/${total}`),
    Comment: Builder.richText(errors.join("\n")),
    "Raw JSON": Builder.richText(rawJson({ syncedAt: new Date().toISOString(), total, processed, done, errors })),
  });
}

function buildBookRecord(bookId: string, book: WeReadBook, notebook?: NotebookBook, progress?: JsonRecord) {
  const progressBook = objectAt(progress, "book");
  const title = safeText(book.title, `WeRead ${bookId}`);
  return upsert(`book:${bookId}`, {
    Title: Builder.title(title),
    "Record ID": Builder.richText(`book:${bookId}`),
    Type: Builder.select("Book"),
    "Book ID": Builder.richText(bookId),
    Book: Builder.richText(title),
    Author: Builder.richText(safeText(book.author)),
    Chapter: Builder.richText(""),
    "Chapter UID": Builder.number(0),
    Range: Builder.richText(""),
    Created: buildDate(numberAt(progressBook, "updateTime")),
    Progress: Builder.number(normalizeProgress(numberAt(progressBook, "progress") ?? notebook?.readingProgress)),
    Count: Builder.number(toNumber(notebook?.noteCount) + toNumber(notebook?.reviewCount)),
    Rating: Builder.number(toNumber(book.newRating)),
    URL: Builder.url(openBookUrl(bookId)),
    Text: Builder.richText(safeText(book.intro)),
    Comment: Builder.richText(`Highlights: ${toNumber(notebook?.noteCount)}, Reviews: ${toNumber(notebook?.reviewCount)}, Bookmarks: ${toNumber(notebook?.bookmarkCount)}`),
    "Raw JSON": Builder.richText(rawJson({ book, notebook, progress })),
  });
}

function buildChapterRecord(bookId: string, book: WeReadBook, chapter: Chapter) {
  const chapterUid = toNumber(chapter.chapterUid);
  return upsert(`chapter:${bookId}:${chapterUid}`, {
    Title: Builder.title(safeText(chapter.title, `Chapter ${chapterUid}`)),
    "Record ID": Builder.richText(`chapter:${bookId}:${chapterUid}`),
    Type: Builder.select("Chapter"),
    "Book ID": Builder.richText(bookId),
    Book: Builder.richText(safeText(book.title)),
    Author: Builder.richText(safeText(book.author)),
    Chapter: Builder.richText(safeText(chapter.title)),
    "Chapter UID": Builder.number(chapterUid),
    Range: Builder.richText(""),
    Created: buildDate(chapter.updateTime),
    Progress: Builder.number(0),
    Count: Builder.number(toNumber(chapter.wordCount)),
    Rating: Builder.number(toNumber(chapter.level)),
    URL: Builder.url(openChapterUrl(bookId, chapterUid)),
    Text: Builder.richText(""),
    Comment: Builder.richText(`Index: ${toNumber(chapter.chapterIdx)}`),
    "Raw JSON": Builder.richText(rawJson(chapter)),
  });
}

function buildBookmarkRecord(bookId: string, book: WeReadBook, bookmark: Bookmark, chapters: Map<number, string>) {
  if (!bookmark.bookmarkId || !bookmark.markText) return undefined;
  const chapterName = getChapterName(chapters, bookmark.chapterUid);
  const originalUrl = openRangeUrl(bookId, bookmark.chapterUid, bookmark.range);
  return upsert(`highlight:${bookmark.bookmarkId}`, {
    Title: Builder.title(truncate(bookmark.markText, 180)),
    "Record ID": Builder.richText(`highlight:${bookmark.bookmarkId}`),
    Type: Builder.select("Highlight"),
    "Book ID": Builder.richText(bookId),
    Book: Builder.richText(safeText(book.title)),
    Author: Builder.richText(safeText(book.author)),
    Chapter: Builder.richText(chapterName),
    "Chapter UID": Builder.number(toNumber(bookmark.chapterUid)),
    Range: Builder.richText(safeText(bookmark.range)),
    Created: buildDate(bookmark.createTime),
    Progress: Builder.number(0),
    Count: Builder.number(0),
    Rating: Builder.number(0),
    URL: Builder.url(originalUrl),
    Text: Builder.richText(bookmark.markText),
    Comment: Builder.richText(""),
    "Raw JSON": Builder.richText(rawJson(bookmark)),
  }, buildNotePageContent({ book, text: bookmark.markText, chapterName, originalUrl }));
}

function buildReviewRecord(bookId: string, book: WeReadBook, review: Review) {
  if (!review.reviewId || !review.content) return undefined;
  const originalUrl = openRangeUrl(bookId, review.chapterUid, review.range);
  const title = review.abstract || review.content;
  return upsert(`review:${review.reviewId}`, {
    Title: Builder.title(truncate(title, 180)),
    "Record ID": Builder.richText(`review:${review.reviewId}`),
    Type: Builder.select(review.range || review.abstract ? "Thought" : "Review"),
    "Book ID": Builder.richText(bookId),
    Book: Builder.richText(safeText(book.title)),
    Author: Builder.richText(safeText(book.author)),
    Chapter: Builder.richText(safeText(review.chapterName)),
    "Chapter UID": Builder.number(toNumber(review.chapterUid)),
    Range: Builder.richText(safeText(review.range)),
    Created: buildDate(review.createTime),
    Progress: Builder.number(0),
    Count: Builder.number(0),
    Rating: Builder.number(review.star && review.star > 0 ? review.star : 0),
    URL: Builder.url(originalUrl),
    Text: Builder.richText(safeText(review.abstract)),
    Comment: Builder.richText(review.content),
    "Raw JSON": Builder.richText(rawJson(review)),
  }, buildNotePageContent({ book, text: review.abstract, comment: review.content, chapterName: review.chapterName, originalUrl }));
}

function buildShelfRecords(shelf: JsonRecord) {
  const records: JsonRecord[] = [];
  for (const item of arrayAt(shelf, "books")) {
    const bookId = safeText(item.bookId);
    records.push(upsert(`shelf-book:${bookId}`, baseShelfProperties({
      id: `shelf-book:${bookId}`,
      type: "Shelf Book",
      title: safeText(item.title, bookId),
      bookId,
      author: safeText(item.author),
      url: bookId ? openBookUrl(bookId) : "",
      raw: item,
    })));
  }
  for (const item of arrayAt(shelf, "albums")) {
    const album = objectAt(item, "albumInfo");
    const albumId = safeText(album.albumId);
    records.push(upsert(`shelf-album:${albumId}`, baseShelfProperties({
      id: `shelf-album:${albumId}`,
      type: "Shelf Album",
      title: safeText(album.name, albumId),
      bookId: albumId,
      author: safeText(album.authorName),
      url: "",
      raw: item,
    })));
  }
  if (shelf.mp && typeof shelf.mp === "object") {
    records.push(upsert("shelf-mp:collections", baseShelfProperties({
      id: "shelf-mp:collections",
      type: "Shelf MP",
      title: "文章收藏",
      bookId: "",
      author: "",
      url: "",
      raw: shelf.mp,
    })));
  }
  for (const archive of arrayAt(shelf, "archive")) {
    const name = safeText(archive.name, "Archive");
    records.push(upsert(`shelf-archive:${name}`, baseShelfProperties({
      id: `shelf-archive:${name}`,
      type: "Shelf Archive",
      title: name,
      bookId: "",
      author: "",
      url: "",
      raw: archive,
    })));
  }
  return records;
}

function baseShelfProperties(input: { id: string; type: string; title: string; bookId: string; author: string; url: string; raw: unknown }) {
  return {
    Title: Builder.title(input.title),
    "Record ID": Builder.richText(input.id),
    Type: Builder.select(input.type),
    "Book ID": Builder.richText(input.bookId),
    Book: Builder.richText(input.title),
    Author: Builder.richText(input.author),
    Chapter: Builder.richText(""),
    "Chapter UID": Builder.number(0),
    Range: Builder.richText(""),
    Created: Builder.richText(""),
    Progress: Builder.number(0),
    Count: Builder.number(0),
    Rating: Builder.number(0),
    URL: Builder.url(input.url),
    Text: Builder.richText(""),
    Comment: Builder.richText(""),
    "Raw JSON": Builder.richText(rawJson(input.raw)),
  };
}

function buildStatsRecord(item: JsonRecord) {
  const mode = safeText(item.mode, "monthly");
  const key = `stat:${mode}:${numberAt(item, "baseTime") ?? 0}`;
  return upsert(key, {
    Title: Builder.title(`${mode} reading stats`),
    "Record ID": Builder.richText(key),
    Type: Builder.select("Reading Stat"),
    "Book ID": Builder.richText(""),
    Book: Builder.richText(""),
    Author: Builder.richText(""),
    Chapter: Builder.richText(""),
    "Chapter UID": Builder.number(0),
    Range: Builder.richText(""),
    Created: buildDate(numberAt(item, "baseTime")),
    Progress: Builder.number(0),
    Count: Builder.number(toNumber(numberAt(item, "readDays"))),
    Rating: Builder.number(0),
    URL: Builder.url(""),
    Text: Builder.richText(`Total seconds: ${toNumber(numberAt(item, "totalReadTime"))}`),
    Comment: Builder.richText(`Average seconds: ${toNumber(numberAt(item, "dayAverageReadTime"))}`),
    "Raw JSON": Builder.richText(rawJson(item)),
  });
}

async function fetchRecentNotebooks(maxPages: number): Promise<NotebookBook[]> {
  const books: NotebookBook[] = [];
  let lastSort: number | undefined;
  let pages = 0;
  for (;;) {
    const body: JsonRecord = { api_name: "/user/notebooks", count: PAGE_SIZE };
    if (lastSort !== undefined) body.lastSort = lastSort;
    const result = await wereadRequest<{ books?: NotebookBook[]; hasMore?: number }>(body);
    pages += 1;
    const pageBooks = result.books ?? [];
    books.push(...pageBooks);
    if (!result.hasMore || pageBooks.length === 0 || pages >= maxPages) return books;
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

async function fetchReadingStats(errors: string[]): Promise<JsonRecord[]> {
  const modes = ["weekly", "monthly", "annually", "overall"];
  const results = await Promise.allSettled(
    modes.map((mode) => wereadRequest<JsonRecord>({ api_name: "/readdata/detail", mode })),
  );
  return results.flatMap((result, index) => {
    const mode = modes[index];
    if (result.status === "fulfilled") return [{ ...result.value, mode }];
    errors.push(`stats:${mode}: ${errorMessage(result.reason)}`);
    return [];
  });
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

function collectBookEntries(notebooks: NotebookBook[]): BookEntry[] {
  const result = new Map<string, BookEntry>();
  for (const notebook of notebooks) {
    const book = notebook.book ?? {};
    const bookId = notebook.bookId ?? book.bookId;
    if (bookId) result.set(bookId, { bookId, seed: { ...book, bookId }, notebook });
  }
  return [...result.values()];
}

function upsert(key: string, properties: JsonRecord, pageContentMarkdown?: string) {
  return { type: "upsert" as const, key, properties, pageContentMarkdown };
}

function buildNotePageContent(input: { book: WeReadBook; text?: string; comment?: string; chapterName?: string; originalUrl: string }) {
  return [
    `Book: ${safeText(input.book.title)}`,
    input.book.author ? `Author: ${input.book.author}` : "",
    input.chapterName ? `Chapter: ${input.chapterName}` : "",
    "",
    input.text ? `> ${input.text.replaceAll("\n", "\n> ")}` : "",
    input.comment ? `\nComment:\n${input.comment}` : "",
    input.originalUrl ? `\n[Open original](${input.originalUrl})` : "",
  ].filter(Boolean).join("\n");
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

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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

function errorMessage(error: unknown) {
  if (error instanceof Error) return truncate(error.message, ERROR_TEXT_LIMIT);
  return truncate(String(error), ERROR_TEXT_LIMIT);
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
