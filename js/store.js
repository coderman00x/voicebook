/**
 * store.js —— IndexedDB 封装
 *
 * 负责持久化三类数据（均仅存于浏览器本地，绝不涉及用户原文件）：
 *   - books      : 书架上的书（含解析后的章节全文，可能很大 → 必须用 IndexedDB）
 *   - progress   : 每本书的续听进度（书id / 章index / 段落index / 百分比）
 *   - bookmarks  : 书签（书名 + 章 + 段落文本片段）
 *
 * 全部方法返回 Promise，调用方 await 即可。
 */

const DB_NAME = 'listen-book-ios';
const DB_VERSION = 1;
const STORE_BOOKS = 'books';
const STORE_PROGRESS = 'progress';
const STORE_BOOKMARKS = 'bookmarks';

/** 单例：延迟打开数据库，避免在未支持环境下加载即报错 */
let dbPromise = null;

/**
 * 打开（或升级）数据库。
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        db.createObjectStore(STORE_BOOKS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_PROGRESS)) {
        db.createObjectStore(STORE_PROGRESS, { keyPath: 'bookId' });
      }
      if (!db.objectStoreNames.contains(STORE_BOOKMARKS)) {
        // 创建书签存储，并为按 bookId 查询/删除建立索引
        const bm = db.createObjectStore(STORE_BOOKMARKS, { keyPath: 'id' });
        bm.createIndex('byBook', 'bookId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** 把 IDBRequest 包装成 Promise */
function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 取对象存储（指定事务模式） */
function store(db, name, mode) {
  return db.transaction(name, mode).objectStore(name);
}

/** 生成带前缀的唯一 id */
export function genId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ============================ Books ============================ */

/**
 * 保存一本书（新增或更新）。
 * @param {object} book { id, title, filename, type, chapters, importedAt }
 */
export async function putBook(book) {
  const db = await openDB();
  await reqToPromise(store(db, STORE_BOOKS, 'readwrite').put(book));
  return book;
}

/** 获取全部书（按导入时间倒序） */
export async function getAllBooks() {
  const db = await openDB();
  const list = await reqToPromise(store(db, STORE_BOOKS, 'readonly').getAll());
  list.sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0));
  return list;
}

/** 按 id 获取一本书 */
export async function getBook(id) {
  const db = await openDB();
  return reqToPromise(store(db, STORE_BOOKS, 'readonly').get(id));
}

/**
 * 删除一本书：仅删 IndexedDB 记录，绝不触碰用户原文件。
 * 同时清理该书关联的进度与书签。
 * @param {string} id
 */
export async function deleteBook(id) {
  const db = await openDB();
  const txn = db.transaction(
    [STORE_BOOKS, STORE_PROGRESS, STORE_BOOKMARKS],
    'readwrite'
  );
  txn.objectStore(STORE_BOOKS).delete(id);
  txn.objectStore(STORE_PROGRESS).delete(id);
  const bmStore = txn.objectStore(STORE_BOOKMARKS);
  const cursorReq = bmStore.index('byBook').openCursor(IDBKeyRange.only(id));
  cursorReq.onsuccess = (e) => {
    const cursor = e.target.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };
  return new Promise((resolve, reject) => {
    txn.oncomplete = () => resolve();
    txn.onerror = () => reject(txn.error);
  });
}

/* =========================== Progress ========================== */

/**
 * 保存续听进度。
 * @param {object} progress { bookId, chapterIndex, chunkIndex, percent }
 */
export async function saveProgress(progress) {
  const db = await openDB();
  progress.updatedAt = Date.now();
  await reqToPromise(store(db, STORE_PROGRESS, 'readwrite').put(progress));
  return progress;
}

/** 获取某本书的进度（无则返回 null） */
export async function getProgress(bookId) {
  const db = await openDB();
  return reqToPromise(store(db, STORE_PROGRESS, 'readonly').get(bookId));
}

/* =========================== Bookmarks ========================= */

/**
 * 新增书签。
 * @param {object} bookmark { bookId, bookTitle, chapterIndex, chunkIndex, chapterTitle, snippet }
 */
export async function addBookmark(bookmark) {
  const db = await openDB();
  if (!bookmark.id) bookmark.id = genId('bm');
  bookmark.createdAt = Date.now();
  await reqToPromise(store(db, STORE_BOOKMARKS, 'readwrite').put(bookmark));
  return bookmark;
}

/** 获取某本书的全部书签（按创建时间正序） */
export async function getBookmarks(bookId) {
  const db = await openDB();
  const list = await reqToPromise(
    store(db, STORE_BOOKMARKS, 'readonly').index('byBook').getAll(IDBKeyRange.only(bookId))
  );
  list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return list;
}

/** 获取所有书签（用于“全部书签”视图） */
export async function getAllBookmarks() {
  const db = await openDB();
  const list = await reqToPromise(store(db, STORE_BOOKMARKS, 'readonly').getAll());
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return list;
}

/** 删除书签 */
export async function deleteBookmark(id) {
  const db = await openDB();
  await reqToPromise(store(db, STORE_BOOKMARKS, 'readwrite').delete(id));
  return id;
}
