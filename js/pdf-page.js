// Lokit hosts the official, byte-for-byte PdfCraft Web release in a same-origin frame.
// The PDF never leaves the browser; only static WASM, JS and OCR models are fetched.
const root = new URL('./pdfcraft/', document.baseURI);
const status = document.querySelector('#pdf-status');
const loading = document.querySelector('#pdf-loading');
const frame = document.querySelector('#pdf-frame');
const offlineButton = document.querySelector('#offline-pdf');
const version = '0.21.1';
const cacheName = 'lokit-pdfcraft-v' + version;
function report(message) { status.textContent = message; }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    report('Автономная работа недоступна: не удалось зарегистрировать PWA.');
  });
}

async function start() {
  try {
    // The original release is staged only in the published site, never loaded from a CDN.
    const response = await fetch(new URL('index.html', root), { cache: 'no-store' });
    if (!response.ok || !(await response.text()).includes('id="pdfcraft"')) {
      throw new Error('Статическая сборка PDFCraft ещё не опубликована.');
    }
    frame.addEventListener('load', () => {
      loading.hidden = true;
      frame.hidden = false;
    }, { once: true });
    frame.src = root.href;
    offlineButton.disabled = !('caches' in window);
    report('Редактор загружен локально. Файлы обрабатываются на устройстве.');
  } catch (error) {
    loading.textContent = 'PDF-движок недоступен. Сборка PDFCraft добавляется при публикации через GitHub Actions. ' + error.message;
    report('Не удалось открыть PDF-редактор.');
  }
}

offlineButton.addEventListener('click', async () => {
  offlineButton.disabled = true;
  try {
    if (!('caches' in window)) throw new Error('Браузер не поддерживает Cache Storage.');
    if (!('serviceWorker' in navigator) || !(await navigator.serviceWorker.getRegistration('./'))) {
      throw new Error('Для автономной работы необходимо разрешить Service Worker.');
    }
    const response = await fetch(new URL('offline-assets.json', root), { cache: 'no-store' });
    if (!response.ok) throw new Error('Нет списка файлов автономной версии.');
    const manifest = await response.json();
    if (manifest.version !== version || !Array.isArray(manifest.files) || manifest.files.length > 1000) {
      throw new Error('Версия PDF-движка или список файлов некорректны.');
    }
    const cache = await caches.open(cacheName);
    let done = 0;
    for (const relative of manifest.files) {
      if (typeof relative !== 'string' || !/^\.\/[a-zA-Z0-9_./-]+$/.test(relative) || relative.includes('..')) {
        throw new Error('Недопустимый путь в списке файлов.');
      }
      const url = new URL(relative, root);
      if (url.origin !== location.origin || !url.pathname.startsWith(root.pathname)) {
        throw new Error('Файл находится вне PDF-движка.');
      }
      if (!(await cache.match(url.href))) {
        const asset = await fetch(url, { cache: 'no-store' });
        if (!asset.ok || asset.type === 'opaque') throw new Error('Не удалось сохранить ' + relative);
        await cache.put(url.href, asset);
      }
      done++;
      report('Сохранение PDF-движка и OCR для автономной работы: ' + done + ' из ' + manifest.files.length);
    }
    // The iframe opens /pdfcraft/, while the manifest lists /pdfcraft/index.html.
    // Cache the directory URL as well so a cold offline restart succeeds.
    const entry = await cache.match(new URL('index.html', root).href);
    if (!entry) throw new Error('Стартовая страница PDF-движка не сохранена.');
    await cache.put(root.href, entry.clone());
    report('PDF-движок и модели распознавания сохранены для работы без интернета.');
  } catch (error) {
    report('Не удалось полностью сохранить офлайн-версию: ' + error.message);
  } finally {
    offlineButton.disabled = false;
  }
});

start();
