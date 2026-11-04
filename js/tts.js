/**
 * tts.js —— Web Speech API 封装（听书核心）
 *
 * 关键 iOS 兼容策略：
 *   1. 首次 speak 必须由「用户手势」触发（调用方需保证 play() 来自点击）。
 *   2. iOS 的 pause()/resume() 不可靠 → 本实现的「暂停」= 记录当前段落位置 + cancel()；
 *      「继续」= 从当前段落重新 speak（无法真正 resume，这是 iOS 限制）。
 *   3. 长文本会被 parse.splitSentences 切成小段，逐句 speak，
 *      用 utterance.onend 推进队列，规避 iOS 对超长文本的截断。
 *   4. onerror 兜底：非用户取消的中断自动推进到下一句。
 *
 * 事件（通过 on(event, cb) 订阅）：
 *   - 'state'    : 播放状态变化（播放/暂停/速率/音调/声线…）
 *   - 'progress' : 续听进度（章index / 段落index / 百分比），用于持久化
 *   - 'chapter'  : 当前章变化（打开书/切章时）
 *   - 'voices'   : 可用声线列表刷新（iOS 首次异步加载后触发）
 *   - 'end'      : 整本读完
 *   - 'error'    : 出错
 */

import { splitSentences } from './parse.js';

function clamp(v, lo, hi) {
  v = Number(v);
  if (!isFinite(v)) v = lo;
  return Math.max(lo, Math.min(hi, v));
}

export class TTSPlayer {
  constructor() {
    this.supported =
      typeof window !== 'undefined' && 'speechSynthesis' in window;
    this.synthesis = this.supported ? window.speechSynthesis : null;

    this.voices = [];
    this.voice = null; // 选中的 SpeechSynthesisVoice
    this.rate = 1.0;
    this.pitch = 1.0;

    this.book = null; // { title, chapters:[{index,title,text}] }
    this.chapterIndex = 0;
    this.chunkIndex = 0;
    this.chunks = []; // 当前章的分段数组

    this.playing = false;
    this.paused = false; // 我们的“暂停”=取消 + 记住位置

    this._listeners = {};
    this._gen = 0; // 会话代次：每次取消/重载自增，用于忽略过期 utterance 回调
    this._chapterChunkCounts = []; // 各章分段数缓存
    this._totalChunks = 0; // 全书分段总数缓存

    if (this.supported) {
      this._loadVoices();
      // iOS 首次 voice 列表异步到达
      this.synthesis.onvoiceschanged = () => this._loadVoices();
    }
  }

  /* ---------------------- 事件系统 ---------------------- */
  on(event, cb) {
    (this._listeners[event] = this._listeners[event] || []).push(cb);
    return this;
  }
  _emit(event, ...args) {
    (this._listeners[event] || []).forEach((cb) => {
      try {
        cb(...args);
      } catch (e) {
        console.error('[tts] listener error', e);
      }
    });
  }

  /* ---------------------- 声线 ---------------------- */
  _loadVoices() {
    if (!this.synthesis) return;
    this.voices = this.synthesis.getVoices() || [];
    if (!this.voice) {
      this.voice =
        this.voices.find((v) => /^zh/i.test(v.lang)) ||
        this.voices[0] ||
        null;
    }
    this._emit('voices', this.getZhVoices(), this.voice);
  }

  /** 仅返回中文（lang 以 zh 开头）的声线 */
  getZhVoices() {
    return (this.voices || []).filter((v) => /^zh/i.test(v.lang));
  }

  setVoice(voiceURI) {
    this.voice =
      this.voices.find((v) => v.voiceURI === voiceURI) ||
      this.voices.find((v) => /^zh/i.test(v.lang)) ||
      this.voices[0] ||
      null;
    this._emit('voice', this.voice);
    this._emit('state', this.getState());
  }

  setRate(r) {
    this.rate = clamp(r, 0.5, 2.0);
    this._emit('state', this.getState());
  }
  setPitch(p) {
    this.pitch = clamp(p, 0.5, 2.0);
    this._emit('state', this.getState());
  }

  /* ---------------------- 状态快照 ---------------------- */
  getState() {
    const ch = this.book ? this.book.chapters[this.chapterIndex] : null;
    return {
      supported: this.supported,
      playing: this.playing,
      paused: this.paused,
      bookTitle: this.book ? this.book.title : '',
      chapterIndex: this.chapterIndex,
      chunkIndex: this.chunkIndex,
      chapterTitle: ch ? ch.title : '',
      chapterCount: this.book ? this.book.chapters.length : 0,
      chunkCount: this.chunks.length,
      percent: this._percent(),
      rate: this.rate,
      pitch: this.pitch,
      voice: this.voice
        ? {
            name: this.voice.name,
            lang: this.voice.lang,
            voiceURI: this.voice.voiceURI,
          }
        : null,
    };
  }

  getProgress() {
    return {
      chapterIndex: this.chapterIndex,
      chunkIndex: this.chunkIndex,
      chapterCount: this.book ? this.book.chapters.length : 0,
      chunkCount: this.chunks.length,
      percent: this._percent(),
    };
  }

  /** 计算全书进度百分比（基于缓存的各章分段数） */
  _percent() {
    if (!this.book || this._totalChunks === 0) return 0;
    let done = 0;
    for (let i = 0; i < this.chapterIndex; i++) {
      done += this._chapterChunkCounts[i] || 0;
    }
    done += this.chunkIndex;
    return Math.min(100, Math.round((done / this._totalChunks) * 100));
  }

  /* ---------------------- 载入 / 定位 ---------------------- */
  /** 载入一本书并定位到指定章/段（不自动播放） */
  load(book, chapterIndex = 0, chunkIndex = 0) {
    this.book = book;
    this.chapterIndex = clamp(chapterIndex, 0, book.chapters.length - 1);
    this.chunkIndex = Math.max(0, chunkIndex | 0);
    // 预计算各章分段数，避免进度百分比时反复切分大文本
    this._chapterChunkCounts = book.chapters.map((c) => splitSentences(c.text).length);
    this._totalChunks = this._chapterChunkCounts.reduce((a, b) => a + b, 0);
    this._gen++; // 新书的旧 utterance 回调一律作废
    this.chunks = this._buildChunks(this.chapterIndex);
    this._emit('chapter', this.getCurrentChapterInfo());
    this._emit('state', this.getState());
  }

  _buildChunks(chapterIndex) {
    const ch = this.book.chapters[chapterIndex];
    return ch ? splitSentences(ch.text) : [];
  }

  getCurrentChapterInfo() {
    if (!this.book) return null;
    const ch = this.book.chapters[this.chapterIndex];
    return ch
      ? { index: this.chapterIndex, title: ch.title, text: ch.text }
      : null;
  }

  /** 当前正在朗读的片段文本（用于书签片段） */
  getCurrentChunkText() {
    return this.chunks[this.chunkIndex] || '';
  }

  /* ---------------------- 播放控制 ---------------------- */
  play() {
    if (!this.supported) {
      this._emit('error', new Error('当前浏览器不支持语音合成'));
      return;
    }
    if (!this.book) return;
    if (this.paused) {
      this.resume();
      return;
    }
    this.playing = true;
    this.paused = false;
    this._speakCurrent();
    this._emit('state', this.getState());
  }

  /** 取消当前朗读并自增代次（用于暂停 / 导航 / 停止） */
  _cancelSession() {
    this._gen++;
    if (this.synthesis) this.synthesis.cancel();
  }

  /** 核心：朗读当前段落，结束后推进 */
  _speakCurrent() {
    if (!this.playing) return;
    if (this.chunkIndex >= this.chunks.length) {
      // 本章读完 → 自动进入下一章；若已是最后一章则结束
      if (this.chapterIndex + 1 < this.book.chapters.length) {
        this.nextChapter(true);
      } else {
        this.playing = false;
        this.paused = false;
        this._emit('end');
        this._emit('state', this.getState());
      }
      return;
    }

    const text = this.chunks[this.chunkIndex];
    const gen = this._gen; // 捕获当前代次，过期回调直接忽略
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) {
      u.voice = this.voice;
      u.lang = this.voice.lang;
    }
    u.rate = this.rate;
    u.pitch = this.pitch;

    u.onend = () => {
      if (this._gen !== gen) return; // 已被新会话取代（导航/暂停）
      if (!this.playing) return;
      this.chunkIndex++;
      this._emit('progress', this.getProgress());
      this._speakCurrent();
    };
    u.onerror = (e) => {
      if (this._gen !== gen) return;
      if (!this.playing) return;
      const err = e && e.error;
      // 用户暂停/取消触发的 canceled/interrupted 已通过代次忽略，这里再保险一层
      if (err === 'canceled' || err === 'interrupted') return;
      // iOS 偶发中断：兜底推进到下一句，避免卡死
      this.chunkIndex++;
      this._speakCurrent();
    };

    this._current = u;
    this.synthesis.speak(u);
    this._emit('state', this.getState());
  }

  /** 暂停：记录位置 + cancel（iOS 无可靠 resume） */
  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.paused = true;
    this._cancelSession(); // 取消当前句并作废其回调
    this._emit('state', this.getState());
  }

  /** 继续：从当前段落重新朗读 */
  resume() {
    if (!this.paused) {
      this.play();
      return;
    }
    this.paused = false;
    this.playing = true;
    this._speakCurrent();
    this._emit('state', this.getState());
  }

  /** 停止：彻底结束，回到章首 */
  stop() {
    this.playing = false;
    this.paused = false;
    this._cancelSession();
    this._emit('state', this.getState());
  }

  /* ---------------------- 导航 ---------------------- */
  nextChunk() {
    if (!this.book) return;
    if (this.chunkIndex + 1 < this.chunks.length) {
      this.chunkIndex++;
    } else if (this.chapterIndex + 1 < this.book.chapters.length) {
      this.nextChapter(false);
      return;
    }
    this._afterSeek();
  }

  prevChunk() {
    if (!this.book) return;
    if (this.chunkIndex > 0) {
      this.chunkIndex--;
    } else if (this.chapterIndex > 0) {
      this.chapterIndex--;
      this.chunks = this._buildChunks(this.chapterIndex);
      this.chunkIndex = Math.max(0, this.chunks.length - 1);
    }
    this._afterSeek();
  }

  nextChapter(auto = false) {
    if (!this.book) return;
    if (this.chapterIndex + 1 < this.book.chapters.length) {
      this.chapterIndex++;
      this.chunks = this._buildChunks(this.chapterIndex);
      this.chunkIndex = 0;
      this._emit('chapter', this.getCurrentChapterInfo());
      this._afterSeek(auto);
    }
  }

  prevChapter() {
    if (!this.book) return;
    if (this.chapterIndex > 0) {
      this.chapterIndex--;
      this.chunks = this._buildChunks(this.chapterIndex);
      this.chunkIndex = 0;
      this._emit('chapter', this.getCurrentChapterInfo());
      this._afterSeek();
    }
  }

  seekTo(chapterIndex, chunkIndex = 0) {
    if (!this.book) return;
    this.chapterIndex = clamp(chapterIndex, 0, this.book.chapters.length - 1);
    this.chunks = this._buildChunks(this.chapterIndex);
    this.chunkIndex = clamp(chunkIndex, 0, Math.max(0, this.chunks.length - 1));
    this._afterSeek();
  }

  /** 定位后：若正在播放则取消旧句并从新位置继续（iOS 需先 cancel 再 speak） */
  _afterSeek(autoContinue = false) {
    this._emit('progress', this.getProgress());
    this._emit('state', this.getState());
    if (this.playing || autoContinue) {
      this.playing = true;
      this.paused = false;
      this._cancelSession();
      // 极短延时：iOS 在 cancel() 后立即 speak 偶尔会吞掉首句
      setTimeout(() => {
        if (this.playing) this._speakCurrent();
      }, 20);
    }
  }
}
