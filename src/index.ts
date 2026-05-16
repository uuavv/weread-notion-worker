import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";

const worker = new Worker();
export default worker;

const WEREAD_API_URL = "https://i.weread.qq.com/api/agent/gateway";
const SKILL_VERSION = "1.0.3";
const NOTEBOOK_PAGE_SIZE = 100;
const REVIEW_PAGE_SIZE = 100;

type JsonRecord = Record<string, unknown>;

type NotebookBook = {
  bookId?: string;
  book?: WeReadBook;
  reviewCount?: number;
  noteCount?: number;
  bookmarkCount?: number;
  readingProgress?: number;
  markedStatus?: number;
  sort?: number;
};

type WeReadBook = {
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
};

type Bookmark = {
  bookmarkId?: string;
  bookId?: string;
  chapterUid?: number;
  markText?: string;
  createTime?: number;
  type?: number;
  range?: string;
  colorStyle?: number;
};

type Chapter = {
  chapterUid?: number;
  title?: string;
};

type Review = {
  reviewId?: string;
  content?: string;
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
      Progress: Schema.number("percent"),
      Status: Schema.select([
        { name: "Reading", color: "blue" },
        { name: "Finished", color: "green" },
      ]),
      "Highlight Count": Schema.number(),
      "Review Count": Schema.number(),
      "Bookmark Count": Schema.number(),
      "Open in WeRead": Schema.url(),
      Cover: Schema.url(),
      Intro: Schema.richText(),
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
    },
  },
});

const wereadPacer = worker.pacer("wereadApi", {
  allowedRequests: 60,
  intervalMs: 60_000,
});

worker.sync("wereadNotesSync", {
  database: notesDatabase,
  mode: "replace",
  schedule: (process.env.SYNC_SCHEDULE ?? "6h") as "6h",
  execute: async () => {
    const notebooks = await fetchAllNotebooks();
    const changes: Array<JsonRecord> = [];

    for (const notebook of notebooks) {
      const bookId = notebook.bookId ?? notebook.book?.bookId;
      if (!bookId) {
        continue;
      }

      const book = notebook.book ?? {};
      changes.push(buildBookChange(bookId, book, notebook));

      const [bookmarkResult, reviews] = await Promise.all([
        fetchBookmarks(bookId),
        fetchAllReviews(bookId),
      ]);

      const chapters = mapChapters(bookmarkResult.chapters);

      for (const bookmark of bookmarkResult.bookmarks) {
        const record = buildBookmarkChange(bookId, book, bookmark, chapters);
        if (record) {
          changes.push(record);
        }
      }

      for (const review of reviews) {
        const record = buildReviewChange(bookId, book, review);
        if (record) {
          changes.push(record);
        }
      }
    }

    return { changes: changes as never, hasMore: false };
  },
});

function buildBookChange(bookId: string, book: WeReadBook, notebook: NotebookBook) {
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
      Progress: Builder.number(normalizeProgress(notebook.readingProgress)),
      Status: Builder.select(notebook.markedStatus === 1 ? "Finished" : "Reading"),
      "Highlight Count": Builder.number(toNumber(notebook.noteCount)),
      "Review Count": Builder.number(toNumber(notebook.reviewCount)),
      "Bookmark Count": Builder.number(toNumber(notebook.bookmarkCount)),
      "Open in WeRead": Builder.url(openBookUrl(bookId)),
      Cover: book.cover ? Builder.url(book.cover) : Builder.url(""),
      Intro: Builder.richText(safeText(book.intro)),
    },
    pageContentMarkdown: [
      `# ${title}`,
      "",
      book.author ? `Author: ${book.author}` : "",
      `[Open in WeRead](${openBookUrl(bookId)})`,
      "",
      book.intro ?? "",
    ]
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
  if (!bookmark.bookmarkId || !bookmark.markText) {
    return undefined;
  }

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
    },
    upstreamUpdatedAt: unixToIso(bookmark.createTime),
    pageContentMarkdown: buildNotePageContent({
      book,
      text: bookmark.markText,
      chapterName,
      originalUrl,
    }),
  };
}

function buildReviewChange(bookId: string, book: WeReadBook, review: Review) {
  if (!review.reviewId || !review.content) {
    return undefined;
  }

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

async function fetchAllNotebooks(): Promise<NotebookBook[]> {
  const books: NotebookBook[] = [];
  let lastSort: number | undefined;

  for (;;) {
    const body: JsonRecord = {
      api_name: "/user/notebooks",
      count: NOTEBOOK_PAGE_SIZE,
    };

    if (lastSort !== undefined) {
      body.lastSort = lastSort;
    }

    const result = await wereadRequest<{
      books?: NotebookBook[];
      hasMore?: number;
    }>(body);

    const pageBooks = result.books ?? [];
    books.push(...pageBooks);

    if (!result.hasMore || pageBooks.length === 0) {
      return books;
    }

    lastSort = pageBooks.at(-1)?.sort;
    if (lastSort === undefined) {
      return books;
    }
  }
}

async function fetchBookmarks(bookId: string): Promise<{
  bookmarks: Bookmark[];
  chapters: Chapter[];
}> {
  const result = await wereadRequest<{
    updated?: Bookmark[];
    chapters?: Chapter[];
  }>({
    api_name: "/book/bookmarklist",
    bookId,
  });

  return {
    bookmarks: result.updated ?? [],
    chapters: result.chapters ?? [],
  };
}

async function fetchAllReviews(bookId: string): Promise<Review[]> {
  const reviews: Review[] = [];
  let synckey = 0;

  for (;;) {
    const result = await wereadRequest<{
      reviews?: Array<{ review?: Review } | Review>;
      hasMore?: number;
      synckey?: number;
    }>({
      api_name: "/review/list/mine",
      bookid: bookId,
      count: REVIEW_PAGE_SIZE,
      synckey,
    });

    const pageReviews = (result.reviews ?? [])
      .map((item) => ("review" in item ? item.review : item))
      .filter((item): item is Review => Boolean(item));

    reviews.push(...pageReviews);

    if (!result.hasMore || pageReviews.length === 0) {
      return reviews;
    }

    synckey = result.synckey ?? synckey;
  }
}

async function wereadRequest<T>(body: JsonRecord): Promise<T> {
  const apiKey = process.env.WEREAD_API_KEY;
  if (!apiKey) {
    throw new Error("Missing WEREAD_API_KEY environment variable.");
  }

  await wereadPacer.wait();
  const response = await fetch(WEREAD_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...body,
      skill_version: SKILL_VERSION,
    }),
  });

  if (!response.ok) {
    throw new Error(`WeRead API failed with HTTP ${response.status}.`);
  }

  const json = (await response.json()) as JsonRecord;
  if (json.upgrade_info && typeof json.upgrade_info === "object") {
    throw new Error(`WeRead skill needs upgrade: ${JSON.stringify(json.upgrade_info)}`);
  }

  if (typeof json.errcode === "number" && json.errcode !== 0) {
    throw new Error(`WeRead API error ${json.errcode}: ${safeText(json.errmsg)}`);
  }

  return json as T;
}

function buildNotePageContent(input: {
  book: WeReadBook;
  text?: string;
  comment?: string;
  chapterName?: string;
  originalUrl: string;
}) {
  const lines = [
    `Book: ${safeText(input.book.title)}`,
    input.book.author ? `Author: ${input.book.author}` : "",
    input.chapterName ? `Chapter: ${input.chapterName}` : "",
    "",
    input.text ? `> ${input.text.replaceAll("\n", "\n> ")}` : "",
    input.comment ? `\nComment:\n${input.comment}` : "",
    input.originalUrl ? `\n[Open original](${input.originalUrl})` : "",
  ];

  return lines.filter(Boolean).join("\n");
}

function mapChapters(chapters: Chapter[] | undefined) {
  const result = new Map<number, string>();
  for (const chapter of chapters ?? []) {
    if (typeof chapter.chapterUid === "number" && chapter.title) {
      result.set(chapter.chapterUid, chapter.title);
    }
  }

  return result;
}

function getChapterName(chapters: Map<number, string>, chapterUid?: number) {
  if (chapterUid === undefined) {
    return "";
  }

  return chapters.get(chapterUid) ?? "";
}

function openBookUrl(bookId: string) {
  return `weread://reading?bId=${encodeURIComponent(bookId)}`;
}

function openRangeUrl(bookId: string, chapterUid?: number, range?: string) {
  const parsedRange = parseRange(range);
  if (chapterUid === undefined || !parsedRange) {
    return openBookUrl(bookId);
  }

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
  if (!match) {
    return undefined;
  }

  return { start: match[1], end: match[2] };
}

function buildDate(unixSeconds?: number) {
  const date = unixToIso(unixSeconds)?.slice(0, 10);
  return date ? Builder.date(date) : Builder.richText("");
}

function unixToIso(unixSeconds?: number) {
  if (!unixSeconds) {
    return undefined;
  }

  return new Date(unixSeconds * 1000).toISOString();
}

function normalizeProgress(progress?: number) {
  if (typeof progress !== "number" || Number.isNaN(progress)) {
    return 0;
  }

  return Math.max(0, Math.min(100, progress)) / 100;
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
