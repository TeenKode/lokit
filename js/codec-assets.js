/** Optional same-origin codecs. Never fetch execution code from a remote CDN. */
export const CODEC_CACHE = 'lokit-optional-codecs-v2';
export const DEPENDENCIES = Object.freeze({
  mediabunny: new URL('../assets/codecs/mediabunny-1.65.2.cjs', import.meta.url).href,
  ffmpegCore: new URL('../assets/codecs/ffmpeg-core-0.12.10.js', import.meta.url).href,
  ffmpegWasm: new URL('../assets/codecs/ffmpeg-core-0.12.10.wasm', import.meta.url).href
});
export const CODEC_NAMES = Object.freeze(Object.keys(DEPENDENCIES));
const allowed = new Set(Object.values(DEPENDENCIES));
const cancelError = () => new DOMException('Операция отменена', 'AbortError');

function assertAsset(url) {
  if (!allowed.has(url)) throw new Error('Неизвестный локальный модуль.');
  if (typeof location !== 'undefined' && new URL(url).origin !== location.origin)
    throw new Error('Модуль должен загружаться с домена Lokit.');
}
function checkAbort(signal) { if (signal?.aborted) throw cancelError(); }
async function openCache() {
  if (typeof caches === 'undefined') return null;
  // Private browsing and restricted storage can reject CacheStorage.open().
  // Online codec loading must still work when optional caching is unavailable.
  try { return await caches.open(CODEC_CACHE); }
  catch { return null; }
}
async function loadResponse(url, {signal, requireCache = false} = {}) {
  assertAsset(url); checkAbort(signal);
  const cache = await openCache();
  if (requireCache && !cache) throw new Error('Браузер не поддерживает офлайн-хранилище модулей.');
  const stored = await cache?.match(url);
  if (stored) return stored;
  checkAbort(signal);
  let response;
  try { response = await fetch(url, {signal, credentials:'same-origin', mode:'same-origin'}); }
  catch (e) {
    if (signal?.aborted) throw cancelError();
    throw new Error('Нет доступа к локальному модулю. Проверьте интернет и публикацию файлов сайта.', {cause:e});
  }
  if (!response.ok || response.type === 'opaque')
    throw new Error('Локальный модуль не опубликован (HTTP ' + response.status + ').');
  // Reject accidental HTML/error pages before persisting executable bytes.
  const type = response.headers.get('Content-Type') || '';
  if (/text\/html/i.test(type))
    throw new Error('Вместо модуля сервер вернул HTML.');
  if (cache) {
    try { await cache.put(url, response.clone()); }
    catch (e) {
      if (requireCache) throw new Error('Недостаточно места для офлайн-модулей. Освободите память браузера.', {cause:e});
    }
  }
  checkAbort(signal);
  return response;
}
export async function fetchCodecBlob(url, {signal} = {}) {
  const response = await loadResponse(url, {signal});
  const blob = await response.blob();
  checkAbort(signal);
  if (!blob.size) throw new Error('Локальный модуль пуст.');
  return blob;
}
export async function getCodecStatus() {
  const cache = await openCache();
  if (!cache) return {supported:false, cached:[], missing:[...CODEC_NAMES], complete:false};
  const checks = await Promise.all(CODEC_NAMES.map(async name => Boolean(await cache.match(DEPENDENCIES[name]))));
  const cached = CODEC_NAMES.filter((_, i) => checks[i]);
  return {supported:true, cached, missing:CODEC_NAMES.filter((_, i) => !checks[i]), complete:cached.length === CODEC_NAMES.length};
}
export async function getCodecManifest() {
  const url = new URL('../assets/codecs/manifest.json', import.meta.url).href;
  try {
    const response = await fetch(url, {credentials:'same-origin'});
    if (!response.ok) return null;
    const manifest = await response.json();
    return manifest && Array.isArray(manifest.files) ? manifest : null;
  } catch { return null; }
}
export async function downloadAllCodecs({signal, onProgress = () => {}} = {}) {
  if (typeof caches === 'undefined') throw new Error('В этом браузере нет Cache Storage.');
  for (let index = 0; index < CODEC_NAMES.length; index++) {
    checkAbort(signal);
    const name = CODEC_NAMES[index];
    onProgress({name, completed:index, total:CODEC_NAMES.length});
    await loadResponse(DEPENDENCIES[name], {signal, requireCache:true});
    const cache = await openCache();
    if (!await cache.match(DEPENDENCIES[name])) throw new Error('Модуль не удалось сохранить для работы офлайн.');
    onProgress({name, completed:index + 1, total:CODEC_NAMES.length});
  }
  return getCodecStatus();
}
export async function removeOfflineCodecs() {
  if (typeof caches === 'undefined') return false;
  return caches.delete(CODEC_CACHE);
}
