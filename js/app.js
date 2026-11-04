/**
 * app.js —— 主控制器：导入 / 路由 / 事件编排
 *
 * 职责：
 *   - 初始化播放器与界面
 *   - 导入文件（txt/epub/pdf）→ 解析 → 存入 IndexedDB → 刷新书架
 *   - 打开书 → 断点续听（继续/从头）→ 播放控制
 *   - 进度持久化、书签管理
 *   - PWA service worker 注册
 *
 * 红线：绝不读写用户原文件，所有数据仅在浏览器内。
 */

import * as Store from './store.js';
import * as Parse from './parse.js';
import { TTSPlayer } from './tts.js';
import * as UI from './ui.js';

/* ----------------------------- 全局状态 ----------------------------- */
const player = new TTSPlayer();
let currentBook = null;
let currentBookId = null;
let progressSaveTimer = null;

/* ----------------------------- DOM 引用 ----------------------------- */
const screens = {
  library: document.getElementById('screen-library'),
  player: document.getElementById('screen-player'),
};
const nowTextEl = document.getElementById('now-text');
const unsupportedEl = document.getElementById('unsupported');

/* ----------------------------- 界面组件 ----------------------------- */
const bookshelf = UI.createBookshelf({
  onOpen: (book) => openBook(book),
  onDelete: (book) => confirmDeleteBook(book),
});

const playerBar = UI.createPlayerBar({
  onPlayPause: () => (player.playing ? player.pause() : player.play()),
  onPrevChapter: () => player.prevChapter(),
  onNextChapter: () => player.nextChapter(false),
  onPrevChunk: () => player.prevChunk(),
  onNextChunk: () => player.nextChunk(),
  onRate: (v) => player.setRate(v),
  onPitch: (v) => player.setPitch(v),
  onVoice: (uri) => player.setVoice(uri),
  onBookmark: () => addBookmarkCurrent(),
  onBookmarks: () => showBookmarks(),
  onStop: () => player.stop(),
  onClose: () => backToLibrary(),
});

/* ----------------------------- 初始化 ----------------------------- */
async function init() {
  // 挂载组件
  document.getElementById('shelf').appendChild(bookshelf.root);
  document.getElementById('player-mount').appendChild(playerBar.root);

  // 不支持语音合成时给出明确提示（仍可导入/浏览）
  if (!player.supported) {
    unsupportedEl.style.display = '';
    unsupportedEl.textContent =
      '当前浏览器不支持语音合成（Web Speech API）。请用 iPhone 的 Safari 打开本应用。';
  }

  // 播放器事件 → UI / 持久化
  player.on('state', (s) => playerBar.update(s));
  player.on('voices', (voices, sel) => playerBar.setVoices(voices, sel));
  player.on('chapter', () => updateNowText());
  player.on('progress', (p) => {
    updateNowText();
    if (currentBookId) scheduleSaveProgress(p);
  });
  player.on('end', () => UI.toast('本书已读完 🎉', 'info'));
  player.on('error', (e) =>
    UI.toast(e && e.message ? e.message : '播放出错', 'error')
  );

  setupImport();
  setupServiceWorker();

  await renderShelf();
  showScreen('library');
}

/* ----------------------------- 导入 ----------------------------- */
function setupImport() {
  const input = document.getElementById('file-input');
  const dropZone = document.getElementById('drop-zone');

  document.getElementById('import-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', (e) => {
    handleFiles(e.target.files);
    input.value = '';
  });

  // 桌面端拖拽导入
  if (dropZone) {
    ['dragover', 'dragenter'].forEach((ev) =>
      dropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropZone.classList.add('drag');
      })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      dropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag');
      })
    );
    dropZone.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) handleFiles(files);
    });
  }
}

/**
 * 处理（多）文件导入：解析并写入 IndexedDB。
 * @param {FileList|File[]} fileList
 */
async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  UI.toast(`正在导入 ${files.length} 个文件…`, 'info');
  for (const file of files) {
    try {
      const parsed = await Parse.parseFile(file);
      const book = {
        id: Store.genId('book'),
        title: parsed.title || (file.name || '未命名'),
        filename: file.name || '',
        type: (file.name.split('.').pop() || '').toLowerCase(),
        chapters: parsed.chapters,
        importedAt: Date.now(),
      };
      await Store.putBook(book);
      UI.toast(`已导入：${book.title}`, 'success');
    } catch (err) {
      console.error(err);
      UI.toast(`导入失败：${file.name}（${err.message || err}）`, 'error');
    }
  }
  await renderShelf();
}

/* ----------------------------- 书架刷新 ----------------------------- */
async function renderShelf() {
  const books = await Store.getAllBooks();
  const progressMap = {};
  for (const b of books) {
    const p = await Store.getProgress(b.id);
    if (p) progressMap[b.id] = p;
  }
  bookshelf.update(books, progressMap);
}

/* ----------------------------- 打开书 / 续听 ----------------------------- */
async function openBook(book) {
  currentBook = book;
  currentBookId = book.id;

  player.load(book, 0, 0);
  showScreen('player');
  updateNowText();

  const prog = await Store.getProgress(book.id);
  if (prog && (prog.chunkIndex > 0 || prog.chapterIndex > 0)) {
    askResume(book, prog);
  } else {
    // 无进度：记录初始进度（0%）
    Store.saveProgress({ bookId: book.id, ...player.getProgress() });
  }
}

/** 续听提示：继续 / 从头 */
function askResume(book, prog) {
  const body = UI.el('div', {}, [
    UI.el('p', {
      text: `检测到上次进度：第 ${prog.chapterIndex + 1} 章，约 ${prog.percent || 0}%。`,
    }),
    UI.el('p', { class: 'muted', text: '要从这里继续，还是从头开始听？' }),
  ]);
  UI.openModal({
    title: '继续听书？',
    body,
    actions: [
      {
        label: '从头开始',
        onClick: () => {
          player.seekTo(0, 0);
          Store.saveProgress({ bookId: book.id, ...player.getProgress() });
        },
      },
      {
        label: '继续',
        primary: true,
        onClick: () => {
          player.seekTo(prog.chapterIndex, prog.chunkIndex);
          Store.saveProgress({ bookId: book.id, ...player.getProgress() });
        },
      },
    ],
  });
}

/* ----------------------------- 书签 ----------------------------- */
function addBookmarkCurrent() {
  if (!currentBook) return;
  const info = player.getCurrentChapterInfo();
  const snippet = (player.getCurrentChunkText() || '').slice(0, 60);
  Store.addBookmark({
    bookId: currentBook.id,
    bookTitle: currentBook.title,
    chapterIndex: player.chapterIndex,
    chunkIndex: player.chunkIndex,
    chapterTitle: info ? info.title : '',
    snippet,
  });
  UI.toast('已添加书签 🔖', 'success');
}

async function showBookmarks() {
  const bookmarks = currentBook
    ? await Store.getBookmarks(currentBook.id)
    : await Store.getAllBookmarks();
  const list = UI.renderBookmarksList(bookmarks, {
    onJump: (bm) => jumpToBookmark(bm),
    onDelete: async (bm) => {
      await Store.deleteBookmark(bm.id);
      showBookmarks(); // 刷新列表
    },
  });
  UI.openModal({
    title: currentBook ? `《${currentBook.title}》书签` : '全部书签',
    body: list,
    actions: [{ label: '关闭' }],
  });
}

function jumpToBookmark(bm) {
  if (!currentBook || currentBook.id !== bm.bookId) {
    // 书签属于另一本书 → 先加载该书
    Store.getBook(bm.bookId).then((b) => {
      if (!b) {
        UI.toast('该书已删除', 'error');
        return;
      }
      currentBook = b;
      currentBookId = b.id;
      player.load(b, bm.chapterIndex, bm.chunkIndex);
      showScreen('player');
      player.play(); // 来自用户点击手势，iOS 允许
    });
    return;
  }
  player.seekTo(bm.chapterIndex, bm.chunkIndex);
  player.play();
}

/* ----------------------------- 删除书 ----------------------------- */
function confirmDeleteBook(book) {
  UI.openModal({
    title: '删除本书？',
    body: UI.el('p', {
      text: `确定删除《${book.title}》？仅删除本地记录，绝不会影响你的原文件。`,
    }),
    actions: [
      { label: '取消' },
      {
        label: '删除',
        primary: true,
        onClick: async () => {
          await Store.deleteBook(book.id);
          if (currentBookId === book.id) {
            player.stop();
            backToLibrary();
          }
          await renderShelf();
          UI.toast('已删除', 'info');
        },
      },
    ],
  });
}

/* ----------------------------- 进度持久化（节流） ----------------------------- */
function scheduleSaveProgress(progress) {
  if (progressSaveTimer) clearTimeout(progressSaveTimer);
  progressSaveTimer = setTimeout(() => {
    if (currentBookId) {
      Store.saveProgress({ bookId: currentBookId, ...progress });
    }
  }, 1000);
}

/* ----------------------------- 当前文本显示 ----------------------------- */
function updateNowText() {
  if (!nowTextEl) return;
  const chunk = player.getCurrentChunkText();
  const chapter = player.getCurrentChapterInfo();
  if (chunk) {
    nowTextEl.textContent = chunk;
  } else if (chapter && chapter.text) {
    nowTextEl.textContent = chapter.text.slice(0, 300);
  } else {
    nowTextEl.textContent = '';
  }
}

/* ----------------------------- 屏幕切换 ----------------------------- */
function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('active', key === name);
  }
  if (name === 'library') {
    currentBook = null;
    currentBookId = null;
    renderShelf();
  }
}

function backToLibrary() {
  player.stop();
  showScreen('library');
}

/* ----------------------------- PWA ----------------------------- */
function setupServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('./sw.js')
      .catch((err) => console.warn('SW 注册失败（不影响使用）：', err));
  }
}

/* ----------------------------- 启动 ----------------------------- */
init();
