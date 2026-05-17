import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

const WEREAD_API_URL = "https://i.weread.qq.com/api/agent/gateway";
const SKILL_VERSION = "1.0.3";
const PAGE_SIZE = 100;
const BOOKS_PER_EXECUTION = numberEnv("BOOKS_PER_EXECUTION", 1);
const NOTEBOOK_SCAN_PAGES = numberEnv("NOTEBOOK_SCAN_PAGES", 1);

type JsonRecord = Record<string, unknown>;

type SyncState = {
  entries: BookEntry[];
  index: number;
};

type BookEntry = {
  bookId: string;
  title: string;
  author: string;
};

type NotebookBook = JsonRecord & {
  bookId?: string;
  book?: {
    bookId?: string;
    title?: string;
    author?: string;
  };
  sort?: number;
};

type Bookmark = JsonRecord & {
  bookmarkId?: string;
  chapterUid?: number;
  markText?: string;
  createTime?: number;
  range?: string;
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
  initialTitle: "WeRead Highlights and Notes",
  primaryKeyProperty: "Record ID",
  schema: {
    properties: {
      Title: Schema.title(),
      "Record ID": Schema.richText(),
      Type: Schema.select([
        { name: "Shelf Book", color: "blue" },
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
    let entries = state?.entries;
    let index = state?.index ?? 0;

    if (!entries) {
      const [shelf, notebooks] = await Promise.all([
        fetchShelf().catch(() => ({} as JsonRecord)),
        fetchRecentNotebooks(NOTEBOOK_SCAN_PAGES),
      ]);

      changes.push(...buildShelfBookRecords(shelf));
      entries = collectNotebookEntries(notebooks);
    }

    const batch = entries.slice(index, index + BOOKS_PER_EXECUTION);
    for (const entry of batch) {
      const [bookmarks, reviews] = await Promise.all([
        fetchBookmarks(entry.bookId),
        fetchAllReviews(entry.bookId),
      ]);

      for (const bookmark of bookmarks) {
        const record = buildBookmarkRecord(entry, bookmark);
        if (record) changes.push(record);
      }

      for (const review of reviews) {
        const record = buildReviewRecord(entry, review);
        if (record) changes.push(record);
      }
    }

    index += batch.length;
    const hasMore = index < entries.length;

    return {
      changes: changes as never,
      hasMore,
      nextState: hasMore ? { entries, index } : undefined,
    };
  },
});

function buildShelfBookRecords(shelf: JsonRecord) {
  return arrayAt(shelf, "books").flatMap((item) => {
    const bookId = safeText(item.bookId);
    const title = safeText(item.title, bookId);
    if (!bookId || !title) return [];
    return [
      upsert(`shelf:${bookId}`, {
        Title: Builder.title(title),
        "Record ID": Builder.richText(`shelf:${bookId}`),
        Type: Builder.select("Shelf Book"),
        "Book ID": Builder.richText(bookId),
        Book: Builder.richText(title),
        Author: Builder.richText(safeText(item.author)),
        Chapter: Builder.richText(""),
        "Chapter UID": Builder.number(0),
        Range: Builder.richText(""),
        Created: Builder.richText(""),
        URL: Builder.url(openBookUrl(bookId)),
        Text: Builder.richText(""),
        Comment: Builder.richText(""),
        "Raw JSON": Builder.richText(rawJson(item)),
      }),
    ];
  });
}

function buildBookmarkRecord(book: BookEntry, bookmark: Bookmark) {
  if (!bookmark.bookmarkId || !bookmark.markText) return undefined;
  const url = openRangeUrl(book.bookId, bookmark.chapterUid, bookmark.range);
  return upsert(
    `highlight:${bookmark.bookmarkId}`,
    {
      Title: Builder.title(truncate(bookmark.markText, 180)),
      "Record ID": Builder.richText(`highlight:${bookmark.bookmarkId}`),
      Type: Builder.select("Highlight"),
      "Book ID": Builder.richText(book.bookId),
      Book: Builder.richText(book.title),
      Author: Builder.richText(book.author),
      Chapter: Builder.richText(""),
      "Chapter UID": Builder.number(toNumber(bookmark.chapterUid)),
      Range: Builder.richText(safeText(bookmark.range)),
      Created: buildDate(bookmark.createTime),
      URL: Builder.url(url),
      Text: Builder.richText(bookmark.markText),
      Comment: Builder.richText(""),
      "Raw JSON": Builder.richText(rawJson(bookmark)),
    },
    `Book: ${book.title}\n\n> ${bookmark.markText}\n\n[Open original](${url})`,
  );
}

function buildReviewRecord(book: BookEntry, review: Review) {
  if (!review.reviewId || !review.content) return undefined;
  const type = review.range || review.abstract ? "Thought" : "Review";
  const title = review.abstract || review.content;
  const url = openRangeUrl(book.bookId, review.chapterUid, review.range);
  return upsert(
    `review:${review.reviewId}`,
    {
      Title: Builder.title(truncate(title, 180)),
      "Record ID": Builder.richText(`review:${review.reviewId}`),
      Type: Builder.select(type),
      "Book ID": Builder.richText(book.bookId),
      Book: Builder.richText(book.title),
      Author: Builder.richText(book.author),
      Chapter: Builder.richText(safeText(review.chapterName)),
      "Chapter UID": Builder.number(toNumber(review.chapterUid)),
      Range: Builder.richText(safeText(review.range)),
      Created: buildDate(review.createTime),
      URL: Builder.url(url),
      Text: Builder.richText(safeText(review.abstract)),
      Comment: Builder.richText(review.content),
      "Raw JSON": Builder.richText(rawJson(review)),
    },
    `Book: ${book.title}\n\n${review.abstract ? `> ${review.abstract}\n\n` : ""}${review.content}\n\n[Open original](${url})`,
  );
}

async function fetchShelf() {
  return wereadRequest<JsonRecord>({ api_name: "/shelf/sync" });
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

async function fetchBookmarks(bookId: string): Promise<Bookmark[]> {
  return wereadRequest<{ updated?: Bookmark[] }>({
    api_name: "/book/bookmarklist",
    bookId,
  })
    .then((result) => result.updated ?? [])
    .catch(() => []);
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

async function wereadRequest<T>(body: JsonRecord): Promise<T> {
  const apiKey = process.env.WEREAD_API_KEY;
  if (!apiKey) throw new Error("Missing WEREAD_API_KEY environment variable.");
  await wereadPacer.wait();
  const response = await fetch(WEREAD_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...body, skill_version: SKILL_VERSION }),
  });

  if (!response.ok) throw new Error(`WeRead API failed with HTTP ${response.status}.`);
  const json = (await response.json()) as JsonRecord;
  if (typeof json.errcode === "number" && json.errcode !== 0) {
    throw new Error(`WeRead API error ${json.errcode}: ${safeText(json.errmsg)}`);
  }
  return json as T;
}

function collectNotebookEntries(notebooks: NotebookBook[]) {
  const result = new Map<string, BookEntry>();
  for (const notebook of notebooks) {
    const book = notebook.book ?? {};
    const bookId = notebook.bookId ?? book.bookId;
    if (!bookId) continue;
    result.set(bookId, {
      bookId,
      title: safeText(book.title, bookId),
      author: safeText(book.author),
    });
  }
  return [...result.values()];
}

function upsert(key: string, properties: JsonRecord, pageContentMarkdown?: string) {
  return { type: "upsert" as const, key, properties, pageContentMarkdown };
}

function openBookUrl(bookId: string) {
  return `weread://reading?bId=${encodeURIComponent(bookId)}`;
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
  const date = unixSeconds ? new Date(unixSeconds * 1000).toISOString().slice(0, 10) : undefined;
  return date ? Builder.date(date) : Builder.richText("");
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

function arrayAt(value: unknown, key: string): JsonRecord[] {
  if (!value || typeof value !== "object") return [];
  const child = (value as JsonRecord)[key];
  return Array.isArray(child) ? (child.filter((item) => item && typeof item === "object") as JsonRecord[]) : [];
}
