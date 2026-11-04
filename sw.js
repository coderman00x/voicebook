/**
 * sw.js —— Service Worker（PWA 离线外壳）
 *
 * 策略：cache-first（缓存优先）。
 *   - install 时预缓存应用外壳（HTML/CSS/JS/vendor/图标）
 *   - fetch 时优先返回缓存；同时后台更新缓存（stale-while-revalidate 的轻量版）
 * 这样「添加到主屏幕」后，即便离线也能打开并使用已导入的书。
 */

const CACHE = 'listen-book-ios-v1';

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/store.js',
  './js/parse.js',
  './js/tts.js',
  './js/ui.js',
  './vendor/jszip.min.js',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((resp) => {
          // 仅缓存同源、成功的 GET 响应
          if (resp && resp.status === 200 && resp.type === 'basic') {
            const copy = resp.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return resp;
        })
        .catch(() => cached);
      // 有缓存先用缓存（离线可用），后台再尝试更新
      return cached || fetchPromise;
    })
  );
});
