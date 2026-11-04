/**
 * parse.js —— 把 txt / epub / pdf 解析为统一结构：
 *   { title, chapters: [{ index, title, text }] }
 *
 * 设计要点：
 *   - 纯逻辑函数（detectChapterStarts / splitChapters / splitSentences）不依赖
 *     任何 DOM / IndexedDB / 浏览器 API，可在 Node 中直接 import 做最小自测。
 *   - 依赖浏览器的部分（JSZip、pdf.js、DOMParser）只在具体解析函数内部、
 *     且通过 `window` 运行时访问，因此模块在 Node 下 import 不会报错。
 */

/* ===================== 章节识别（纯逻辑） ===================== */

/**
 * 章节标题识别正则（覆盖中英文常见格式）：
 *   - 第X章 / 第X卷 / 第X回 / 第X部 / 第X篇 / 第X节（中文数字或阿拉伯数字）
 *   - Chapter N
 *   - 数字编号段落：1.  / 2、  / 3．
 *   - （N） 括号编号
 */
export const CHAPTER_PATTERNS = [
  /^\s*第[一二三四五六七八九十百千零〇0-9]+[章卷回部篇节]\s*.*$/,
  /^\s*Chapter\s+\d+.*$/i,
  /^\s*[0-9]+\s*[\.、．]\s*.*$/,
  /^\s*[（(][0-9]+[)）]\s*.*$/,
];

/**
 * 找出所有“章节起始行”的行号（基于行数组）。
 * @param {string[]} lines
 * @returns {number[]} 行索引数组（升序）
 */
export function detectChapterStarts(lines) {
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] || '').trim();
    if (!t) continue;
    for (const re of CHAPTER_PATTERNS) {
      if (re.test(t)) {
        starts.push(i);
        break;
      }
    }
  }
  return starts;
}

/**
 * 把整本文本按章节切分。
 * @param {string} text 全文
 * @param {string} [defaultTitle='正文'] 未识别到章节时的默认标题
 * @returns {Array<{index:number,title:string,text:string}>}
 */
export function splitChapters(text, defaultTitle = '正文') {
  if (typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/);
  const starts = detectChapterStarts(lines);

  // 无任何章节标记 → 整本作为单章
  if (starts.length === 0) {
    const clean = text.trim();
    return [{ index: 0, title: defaultTitle, text: clean }];
  }

  const chapters = [];
  for (let s = 0; s < starts.length; s++) {
    const startLine = starts[s];
    const endLine = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const title = lines[startLine].trim();
    const body = lines.slice(startLine + 1, endLine).join('\n').trim();
    // 跳过“只有标题、没有正文”的空章（常见于封面/分隔行）
    if (!body && s !== starts.length - 1) continue;
    chapters.push({ index: chapters.length, title, text: body });
  }
  // 兜底：若全部被跳过，退回单章
  if (chapters.length === 0) {
    return [{ index: 0, title: defaultTitle, text: text.trim() }];
  }
  return chapters;
}

/* ===================== 句子切分（纯逻辑） ===================== */

/**
 * 把一段文本按“句末标点 + 换行”切分为若干小段（chunk），用于逐句朗读，
 * 规避 iOS 对超长文本一次性 speak 会截断的问题。标点会保留在段尾。
 *
 * 同时对超长片段（>180 字）按逗号/顿号进一步细分。
 *
 * @param {string} text
 * @returns {string[]} 非空片段数组
 */
export function splitSentences(text) {
  if (!text || typeof text !== 'string') return [];
  const enders = '。！？!?；;…\r\n';
  const chunks = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if (enders.includes(ch)) {
      const t = buf.trim();
      if (t) chunks.push(t);
      buf = '';
    }
  }
  if (buf.trim()) chunks.push(buf.trim());

  // 超长片段按逗号/顿号再细分
  const out = [];
  for (const c of chunks) {
    if (c.length > 180) out.push(...splitByComma(c));
    else out.push(c);
  }
  return out.length ? out : (text.trim() ? [text.trim()] : []);
}

/** 内部：按逗号/顿号细分（用于超长句） */
function splitByComma(text) {
  const seps = '，、,';
  const parts = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if (seps.includes(ch)) {
      const t = buf.trim();
      if (t) parts.push(t);
      buf = '';
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.length ? parts : [text];
}

/* ===================== 文件级解析（浏览器） ===================== */

/**
 * 根据扩展名分发解析。
 * @param {File} file
 * @returns {Promise<{title:string, chapters:Array}>}
 */
export async function parseFile(file) {
  const name = file.name || '';
  const lower = name.toLowerCase();
  if (lower.endsWith('.txt')) return parseTxt(file);
  if (lower.endsWith('.epub')) return parseEpub(file);
  if (lower.endsWith('.pdf')) return parsePdf(file);
  throw new Error(`不支持的文件格式：${name}（仅支持 txt / epub / pdf）`);
}

/** txt 解析 */
export async function parseTxt(file) {
  const text = await file.text();
  const title = (file.name || '未命名').replace(/\.txt$/i, '');
  const chapters = splitChapters(text, title);
  return { title, chapters };
}

/**
 * epub 解析：JSZip 解压 → 读 OPF 的 spine/manifest → 按 spine 顺序读取 xhtml
 * → DOMParser 提取 textContent → 按 h1~h3 分章。
 */
export async function parseEpub(file) {
  const JSZip = (typeof window !== 'undefined' && window.JSZip) || null;
  if (!JSZip) throw new Error('JSZip 未加载（vendor/jszip.min.js）');
  const DOMParserCtor =
    (typeof window !== 'undefined' && window.DOMParser) || null;
  if (!DOMParserCtor) throw new Error('当前环境不支持 DOMParser');

  const zip = await JSZip.loadAsync(file);

  // 1) 从 META-INF/container.xml 定位 OPF
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('无效的 EPUB：缺少 container.xml');
  const container = new DOMParserCtor().parseFromString(
    await containerFile.async('text'),
    'application/xml'
  );
  const opfPath = container.getElementsByTagName('rootfile')[0]?.getAttribute('full-path');
  if (!opfPath) throw new Error('无效的 EPUB：找不到 OPF 路径');

  const opfText = await zip.file(opfPath).async('text');
  const opf = new DOMParserCtor().parseFromString(opfText, 'application/xml');

  // 2) manifest: id -> href（EPUB 的 OPF 带命名空间，用 getElementsByTagName 最稳）
  const manifest = {};
  for (const item of opf.getElementsByTagName('item')) {
    const id = item.getAttribute('id');
    if (id) manifest[id] = item.getAttribute('href');
  }

  // 3) spine 顺序: idref 列表
  const spineIds = Array.from(opf.getElementsByTagName('itemref')).map((ref) =>
    ref.getAttribute('idref')
  );

  const opfDir = opfPath.includes('/')
    ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1)
    : '';
  const resolvePath = (href) => opfDir + (href || '').split('#')[0];

  const metaTitle =
    (opf.getElementsByTagName('title')[0]?.textContent || '').trim() || '';
  const title =
    metaTitle || (file.name || '未命名').replace(/\.epub$/i, '');

  const chapters = [];
  for (const id of spineIds) {
    const href = manifest[id];
    if (!href) continue;
    let entry = zip.file(resolvePath(href));
    if (!entry) entry = findZipFile(zip, resolvePath(href)); // 容错：大小写/前缀
    if (!entry) continue;

    const xhtml = await entry.async('text');
    const doc = new DOMParserCtor().parseFromString(
      xhtml,
      'application/xhtml+xml'
    );
    // 注意：XHTML 以 application/xhtml+xml 解析时 document.body 可能为 undefined，
    // 故用 getElementsByTagName('body') 取正文根；脚本/样式会在拆分时被跳过
    const root =
      doc.getElementsByTagName('body')[0] || doc.documentElement;
    const parts = splitXhtmlByHeadings(root, title);
    chapters.push(...parts);
  }

  if (chapters.length === 0) {
    chapters.push({ index: 0, title, text: '（EPUB 未解析到正文内容）' });
  }
  chapters.forEach((c, i) => (c.index = i));
  return { title, chapters };
}

/** 在 zip 中按大小写不敏感 / 前缀匹配查找文件 */
function findZipFile(zip, path) {
  const keys = Object.keys(zip.files);
  const target = path.toLowerCase();
  let found = keys.find((k) => k.toLowerCase() === target);
  if (!found) {
    found = keys.find((k) => k.toLowerCase().endsWith('/' + target));
  }
  return found ? zip.file(found) : null;
}

/**
 * 按 h1~h3 标题把一段 xhtml 的正文拆分为多个章节。
 * 文本节点逐字收集，块级元素前后补换行，避免重复文本。
 */
function splitXhtmlByHeadings(root, defaultTitle) {
  const out = [];
  let current = { index: 0, title: defaultTitle, text: '' };

  const isHeading = (el) => /^h[1-3]$/.test(el.tagName.toLowerCase());
  const isSubHeading = (el) => /^h[4-6]$/.test(el.tagName.toLowerCase());
  const isBlock = (el) => {
    const t = el.tagName.toLowerCase();
    return [
      'p', 'div', 'section', 'article', 'li', 'tr', 'blockquote',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'ul', 'ol',
    ].includes(t);
  };

  const walk = (node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        // 文本节点
        const t = child.textContent;
        if (t) current.text += t;
      } else if (child.nodeType === 1) {
        const el = child;
        const tag = el.tagName.toLowerCase();
        if (tag === 'br') {
          current.text += '\n';
          return;
        }
        // 跳过脚本/样式/无脚本区，避免脏文本混入
        if (tag === 'script' || tag === 'style' || tag === 'noscript') {
          return;
        }
        if (isHeading(el)) {
          if (current.text.trim()) out.push(current);
          current = {
            index: 0,
            title: (el.textContent || '').trim() || defaultTitle,
            text: '',
          };
          return;
        }
        if (isSubHeading(el)) {
          current.text += '\n' + (el.textContent || '').trim() + '\n';
          return;
        }
        const block = isBlock(el);
        if (block && current.text && !current.text.endsWith('\n')) {
          current.text += '\n';
        }
        walk(el);
        if (block && current.text && !current.text.endsWith('\n')) {
          current.text += '\n';
        }
      }
    });
  };

  walk(root);
  if (current.text.trim()) out.push(current);

  // 清理多余空行
  out.forEach((c) => {
    c.text = (c.text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  });
  return out.filter((c) => c.text);
}

/**
 * pdf 解析：pdf.js 逐页 getTextContent 抽取文本，整本合并为一个章节
 * （PDF 通常无章节结构；如需更细可按空行切分，这里保持单章以简化导航）。
 */
export async function parsePdf(file) {
  const pdfjsLib =
    (typeof window !== 'undefined' && window.pdfjsLib) || null;
  if (!pdfjsLib) throw new Error('pdf.js 未加载（vendor/pdf.min.js）');

  // 设置 worker（用 import.meta.url 解析，保证任意挂载路径下都能找到）
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      '../vendor/pdf.worker.min.js',
      import.meta.url
    ).href;
  }

  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const title = (file.name || '未命名').replace(/\.pdf$/i, '');

  let allText = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((it) => it.str)
      .join(' ')
      .replace(/\s+\n/g, '\n')
      .trim();
    allText += `\n【第 ${p} / ${pdf.numPages} 页】\n${pageText}\n`;
  }

  const text = allText.trim();
  const chapters = [
    {
      index: 0,
      title,
      text: text || '（PDF 未提取到文本，可能是扫描版/图片型 PDF）',
    },
  ];
  return { title, chapters };
}
