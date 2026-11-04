/**
 * ui.js —— 渲染层：书架 / 播放器 / 弹窗 / 书签
 *
 * 采用「工厂函数」模式：DOM 只构建一次，之后通过返回的 update()/setVoices()
 * 做增量更新，避免重建导致滑块失焦、事件丢失。
 *
 * 所有触感元素均 ≥44px，方便 iPhone 单手操作。
 */

/**
 * 轻量 DOM 构造助手。
 * @param {string} tag
 * @param {object} [props] 支持 class/text/html/dataset/on* 事件/普通属性
 * @param {Array} [children]
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else {
      node.setAttribute(k, v);
    }
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/* ============================ 书架 ============================ */

/**
 * 创建书架视图。
 * @param {object} handlers { onOpen(book), onDelete(book) }
 */
export function createBookshelf(handlers) {
  const empty = el('div', {
    class: 'empty',
    text: '书架还是空的。点击右上角「导入」，选择 txt / epub / pdf 开始听书。',
  });
  const grid = el('div', { class: 'book-grid' });
  const root = el('div', { class: 'shelf' }, [empty, grid]);

  function update(books, progressMap = {}) {
    grid.innerHTML = '';
    if (!books || books.length === 0) {
      empty.style.display = '';
      grid.style.display = 'none';
      return;
    }
    empty.style.display = 'none';
    grid.style.display = '';
    for (const book of books) {
      const prog = progressMap[book.id];
      const pct = prog && typeof prog.percent === 'number' ? prog.percent : 0;
      const card = el(
        'div',
        { class: 'book-card', onClick: () => handlers.onOpen(book) },
        [
          el('div', { class: 'book-title', text: book.title }),
          el('div', {
            class: 'book-meta',
            text: `${book.chapters.length} 章 · ${book.filename || '未知来源'}`,
          }),
          el('div', { class: 'progress' }, [
            el('div', { class: 'progress-bar', style: `width:${pct}%` }),
          ]),
          el('div', {
            class: 'book-pct',
            text: pct > 0 ? `已听 ${pct}%` : '未开始',
          }),
          el('button', {
            class: 'btn-icon del',
            title: '删除本书',
            onClick: (e) => {
              e.stopPropagation();
              handlers.onDelete(book);
            },
          }, ['✕']),
        ]
      );
      grid.appendChild(card);
    }
  }

  return { root, update };
}

/* ============================ 播放器 ============================ */

/**
 * 创建播放器底栏。
 * handlers 含：onPlayPause / onPrevChapter / onNextChapter / onPrevChunk /
 * onNextChunk / onRate(v) / onPitch(v) / onVoice(uri) / onBookmark /
 * onBookmarks / onStop / onClose
 */
export function createPlayerBar(handlers) {
  const titleEl = el('div', { class: 'pl-title' });
  const chapterEl = el('div', { class: 'pl-chapter' });
  const pctEl = el('div', { class: 'pl-pct' });

  const btnPrevCh = el('button', { class: 'btn', title: '上一章', onClick: handlers.onPrevChapter }, ['⏮']);
  const btnPrev = el('button', { class: 'btn', title: '上一段', onClick: handlers.onPrevChunk }, ['⏪']);
  const btnPlay = el('button', { class: 'btn btn-play', title: '播放 / 暂停', onClick: handlers.onPlayPause }, ['▶']);
  const btnNext = el('button', { class: 'btn', title: '下一段', onClick: handlers.onNextChunk }, ['⏩']);
  const btnNextCh = el('button', { class: 'btn', title: '下一章', onClick: handlers.onNextChapter }, ['⏭']);

  const rate = el('input', {
    type: 'range', min: '0.5', max: '2.0', step: '0.05', value: '1.0',
    class: 'slider', onInput: (e) => handlers.onRate(parseFloat(e.target.value)),
  });
  const rateVal = el('span', { class: 'val', text: '1.00x' });
  const pitch = el('input', {
    type: 'range', min: '0.5', max: '2.0', step: '0.05', value: '1.0',
    class: 'slider', onInput: (e) => handlers.onPitch(parseFloat(e.target.value)),
  });
  const pitchVal = el('span', { class: 'val', text: '1.00' });

  const voiceSel = el('select', {
    class: 'voice-sel',
    onChange: (e) => handlers.onVoice(e.target.value),
  });

  const btnBm = el('button', { class: 'btn btn-sm', onClick: handlers.onBookmark }, ['🔖 书签']);
  const btnBms = el('button', { class: 'btn btn-sm', onClick: handlers.onBookmarks }, ['📑 列表']);
  const btnStop = el('button', { class: 'btn btn-sm', onClick: handlers.onStop }, ['⏹ 停止']);
  const btnClose = el('button', { class: 'btn btn-sm', onClick: handlers.onClose }, ['✕ 书架']);

  const root = el('div', { class: 'player', id: 'player' }, [
    el('div', { class: 'pl-head' }, [titleEl, chapterEl, pctEl]),
    el('div', { class: 'pl-controls' }, [btnPrevCh, btnPrev, btnPlay, btnNext, btnNextCh]),
    el('div', { class: 'pl-row' }, [el('label', { text: '倍速' }), rate, rateVal]),
    el('div', { class: 'pl-row' }, [el('label', { text: '音调' }), pitch, pitchVal]),
    el('div', { class: 'pl-row' }, [el('label', { text: '声线' }), voiceSel]),
    el('div', { class: 'pl-row pl-actions' }, [btnBm, btnBms, btnStop, btnClose]),
  ]);

  function update(state) {
    titleEl.textContent = state.bookTitle || '';
    chapterEl.textContent = state.chapterTitle || '';
    pctEl.textContent = `${state.chapterIndex + 1}/${state.chapterCount} · ${state.percent ?? 0}%`;
    btnPlay.textContent = state.playing ? '⏸' : '▶';
    rate.value = String(state.rate);
    rateVal.textContent = Number(state.rate).toFixed(2) + 'x';
    pitch.value = String(state.pitch);
    pitchVal.textContent = Number(state.pitch).toFixed(2);
    if (!state.supported) {
      btnPlay.disabled = true;
      btnPlay.textContent = '🚫';
    }
  }

  /** 刷新声线下拉（iOS 首次异步加载后调用） */
  function setVoices(voices, selected) {
    voiceSel.innerHTML = '';
    if (!voices || voices.length === 0) {
      voiceSel.appendChild(el('option', { value: '' }, ['（无中文声线，请检查系统语言）']));
      return;
    }
    for (const v of voices) {
      const opt = el('option', { value: v.voiceURI }, [`${v.name} (${v.lang})`]);
      if (selected && v.voiceURI === selected.voiceURI) opt.selected = true;
      voiceSel.appendChild(opt);
    }
  }

  return { root, update, setVoices };
}

/* ============================ 弹窗 ============================ */

/**
 * 打开一个模态弹窗。
 * @param {object} opts { title, body(节点), actions:[{label,primary,onClick,keepOpen}] }
 * @returns {{close:Function}}
 */
export function openModal(opts) {
  const overlay = el('div', { class: 'modal-overlay' });
  const close = () => {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };

  const actionsRow = el('div', { class: 'modal-actions' });
  for (const a of opts.actions || []) {
    actionsRow.appendChild(
      el('button', {
        class: 'btn' + (a.primary ? ' btn-primary' : ''),
        onClick: () => {
          if (a.onClick) a.onClick();
          if (!a.keepOpen) close();
        },
      }, [a.label])
    );
  }

  const box = el('div', { class: 'modal' }, [
    opts.title ? el('div', { class: 'modal-title', text: opts.title }) : null,
    el('div', { class: 'modal-body' }, [opts.body]),
    actionsRow,
  ]);
  overlay.appendChild(box);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  return { close };
}

/* ============================ 书签列表 ============================ */

/**
 * 渲染书签列表节点。
 * @param {Array} bookmarks
 * @param {object} handlers { onJump(bm), onDelete(bm) }
 */
export function renderBookmarksList(bookmarks, handlers) {
  if (!bookmarks || bookmarks.length === 0) {
    return el('div', { class: 'empty', text: '还没有书签。播放时点「🔖 书签」即可添加。' });
  }
  const ul = el('ul', { class: 'bm-list' });
  for (const bm of bookmarks) {
    ul.appendChild(
      el('li', { class: 'bm-item', onClick: () => handlers.onJump(bm) }, [
        el('div', {
          class: 'bm-chapter',
          text: `${bm.bookTitle} · ${bm.chapterTitle || '第' + (bm.chapterIndex + 1) + '章'}`,
        }),
        el('div', { class: 'bm-snippet', text: bm.snippet || '' }),
        el('button', {
          class: 'btn-icon del',
          title: '删除书签',
          onClick: (e) => {
            e.stopPropagation();
            handlers.onDelete(bm);
          },
        }, ['✕']),
      ])
    );
  }
  return ul;
}

/* ============================ Toast ============================ */

/** 轻量提示条 */
export function toast(message, type = 'info') {
  const t = el('div', { class: `toast toast-${type}`, text: message });
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 300);
  }, 2600);
}
