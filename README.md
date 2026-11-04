# 听书 · ListenBook (iOS)

一个**纯前端、零后端**的听书 Web App。把电子书（txt / epub / pdf）导入到 iPhone 的 Safari，
用**设备自带的语音合成（Web Speech API / Apple 中文嗓音）**实时朗读，全程不需要任何服务器。
可「添加到主屏幕」作为 PWA 离线使用。

> 项目名：`listen-book-ios`。无任何构建步骤，原生 ES Module + 本地 vendor 库。

---

## 特性

- 📥 **导入**：文件选择器选 txt / epub / pdf（桌面支持拖拽），可多选。
- 📚 **解析**：自动识别章节（txt 正则 / epub spine / pdf 逐页），结构统一为
  `{ title, chapters: [{ index, title, text }] }`。
- 🗄️ **书架**：书与解析后的全文存入 **IndexedDB**（不用 localStorage，避免大文本爆掉）。
  显示书名 / 章节数 / 进度百分比，可删除（仅删本地记录，**绝不碰你的原文件**）。
- 🔊 **播放器**：基于 Web Speech API 封装——
  - 枚举并筛选中文（lang 以 `zh` 开头）嗓音；iOS 首次异步加载后自动刷新列表。
  - 文本按句子/小段切分逐句朗读，规避 iOS 长文本截断。
  - 控制：播放/暂停、上一章/下一章、上一段/下一段、倍速滑杆（0.5–2.0）、音调滑杆（0.5–2.0）、声线下拉。
  - **断点续听**：记录 书/章/段，重开该书提示「继续/从头」。
  - **书签**：给当前位置加书签（书名+章+段落片段），列表可点击跳转。
- 📱 **PWA**：`manifest.webmanifest` + `sw.js`（cache-first 离线可用）+ `apple-touch-icon`。
- 🌙 **iOS 适配**：大触控区（≥44px）、安全区 `env(safe-area-inset-*)`、深色模式友好、竖屏优先。

---

## 在 iPhone 上怎么用

### 方式一：本地服务 + 局域网（开发/自测最方便）

1. 在电脑上进入项目目录，启动静态服务：

   ```bash
   cd listen-book-ios
   ./serve.sh            # 默认端口 8080，也可 ./serve.sh 9000
   ```

2. 脚本会打印**局域网地址**（如 `http://192.168.x.x:8080/`）。
   确保 iPhone 与电脑连在**同一 Wi-Fi**。
3. 在 iPhone 的 **Safari** 打开该局域网地址。
4. 点 Safari 底部「分享」→「**添加到主屏幕**」，即可像原生 App 一样全屏使用。

> 也可直接 `python3 -m http.server 8080` 起服务，再用 `ipconfig`/`ifconfig` 查电脑局域网 IP。

### 方式二：GitHub Pages 自动托管（推荐 · 长期零电脑）✅

部署一次后，iPhone 只访问一个 HTTPS 链接即可，**电脑可彻底关掉**。仓库已内置工作流 `.github/workflows/deploy.yml` + `.nojekyll`：

1. 在 GitHub 新建一个**公开仓库**（如 `listen-book-ios`）。
2. 把 `listen-book-ios/` 目录下的全部文件推到仓库根（或把 `deploy.yml` 里的 `path: .` 改成子目录名）。
3. 仓库 **Settings → Pages → Build and deployment → Source 选「GitHub Actions」**。
4. 推一次 `main` 分支，Actions 会自动构建并发布；几分钟后访问
   `https://<你的用户名>.github.io/<仓库名>/` 即可。
5. iPhone Safari 打开该地址 →「分享 → 添加到主屏幕」。

> 全程用的是相对路径，子路径（`/<仓库名>/`）下也能正常加载、注册 Service Worker 与 PWA。

### 方式三：Vercel / Netlify 拖拽（更快，但不自动）

- **Vercel**：打开 vercel.com → New Project → 选「Deploy from CLI / Drag & Drop」拖入 `listen-book-ios/` 文件夹；框架选「Other」，无需构建命令。
- **Netlify**：打开 app.netlify.com → Drop → 拖入文件夹即可得一个 HTTPS 地址。
- **任意 Nginx**：把目录放到 `html/` 下，`location / { try_files $uri $uri/ /index.html; }`。

部署后访问站点 HTTPS 地址（**强烈建议 HTTPS**，iOS 对语音与 PWA 更友好），「添加到主屏幕」即可。

### 怎么听书

1. 打开 App → 点右上角「**＋ 导入**」→ 选择 txt / epub / pdf（可多选）。
2. 导入完成后在书架点书名进入播放器。
3. 点「▶」开始朗读（**首次必须由你点一下触发**，这是 iOS 限制）。
4. 用底部控件调节倍速/音调/声线，或用「⏮ ⏪ ⏩ ⏭」跳章跳段。
5. 听到哪点「🔖 书签」记录位置；「📑 列表」查看并跳转。
6. 下次打开同一本书会提示「继续 / 从头」。

---

## 已知 iOS 限制（务必了解）

| 限制 | 说明 | 应对 |
|---|---|---|
| 屏幕锁定会暂停语音 | iOS 锁屏后 `speechSynthesis` 停止 | 听书时保持屏幕亮着（或降低亮度）；可开启「辅助功能 → 语音内容」等系统能力辅助 |
| 长链路约 15 分钟可能中断 | 系统对单次语音会话有时长限制 | 本 App 已按句切分、每句重新 `speak`，多数情况可自动续；若中断，点「▶」即可从当前段继续 |
| 后台不播放 | iOS 不允许网页在后台继续朗读 | 保持 Safari 在前台 |
| 首次需用户手势触发 | iOS 要求 `speak()` 来自点击 | 播放/继续一律由按钮点击触发，已满足 |
| 暂停实现为取消+重说 | iOS 的 `pause()/resume()` 不可靠 | 暂停 = 记录位置并 `cancel()`；继续 = 从当前段重念（可能重复最后一句开头，属正常） |
| 声线依赖系统 | 中文嗓音由设备系统提供 | 在 iPhone「设置 → 辅助功能 → 语音内容 → 嗓音」中下载中文（如「婷婷」「Yuna」）后可用；`voiceschanged` 后会自动刷新列表 |
| 扫描版 PDF 无文本 | 图片型 PDF 抽不到文字 | 仅支持**文本型** PDF；扫描版需先 OCR |

---

## 目录结构

```
listen-book-ios/
├── index.html              # 页面外壳（含 PWA meta）
├── manifest.webmanifest    # PWA 清单
├── sw.js                   # Service Worker（离线缓存）
├── .nojekyll               # 禁用 GitHub Pages 的 Jekyll 处理
├── .github/
│   └── workflows/
│       └── deploy.yml      # GitHub Pages 自动部署工作流
├── serve.sh                # 本地起服务脚本（含局域网提示）
├── README.md
├── css/styles.css
├── js/
│   ├── app.js              # 主控制器 / 路由 / 事件
│   ├── store.js            # IndexedDB：书架 + 进度 + 书签
│   ├── parse.js            # txt/epub/pdf 解析（纯逻辑可在 Node 测）
│   ├── tts.js              # Web Speech API 封装
│   └── ui.js               # 书架 / 播放器 / 弹窗 渲染
├── vendor/
│   ├── jszip.min.js        # epub 解压（本地）
│   ├── pdf.min.js          # pdf.js（本地）
│   └── pdf.worker.min.js   # pdf.js worker（本地）
└── assets/
    ├── icon.svg / icon-192.png / icon-512.png / apple-touch-icon.png
```

---

## 技术约束与说明

- **零后端、零构建**：原生 ES Module，vendor 库（jszip、pdf.js）已下载到 `vendor/` 本地引用，保证离线。
- **红线**：绝不读写用户原文件；所有数据只在浏览器 IndexedDB / 内存。
- **优雅降级**：若 `!('speechSynthesis' in window)`，UI 明确提示「请用 iPhone 的 Safari」。
- **图标**：已生成 SVG 与 PNG（纯 Python 生成，无第三方依赖）。若需更精致图标，可替换 `assets/` 下的 PNG。

---

## 开发者自测

1. 起服务并检查关键资源返回 200：

   ```bash
   cd listen-book-ios
   python3 -m http.server 8080 &
   for f in index.html manifest.webmanifest sw.js \
            js/app.js js/store.js js/parse.js js/tts.js js/ui.js \
            vendor/jszip.min.js vendor/pdf.min.js vendor/pdf.worker.min.js; do
     code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8080/$f")
     echo "$code  $f"
   done
   ```

2. 对 `parse.js` 的纯逻辑（分章正则 / 句子切分）做最小 Node 自测：

   ```bash
   cp js/parse.js /tmp/parse_test.mjs
   node --input-type=module -e "
     import('/tmp/parse_test.mjs').then(m => {
       const txt = '第一章 开始\n这是第一句。这是第二句。\n第二章 继续\nHello world. How are you?';
       const ch = m.splitChapters(txt, '正文');
       console.log('章节数:', ch.length, ch.map(c=>c.title));
       const s = m.splitSentences('这是第一句。这是第二句。Hello world. Bye!');
       console.log('分段数:', s.length, s);
       if (ch.length >= 2 && s.length >= 3) console.log('PASS'); else console.log('FAIL');
     });
   "
   ```

> ⚠️ 本机无 iOS、无语音引擎，**真机朗读需在 iPhone 的 Safari 验证**。
