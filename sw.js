// Service worker : l'application fonctionne sans réseau une fois installée
const CACHE = 'cr-1.7.0';
const SHELL = ['./', 'index.html', 'app.js', 'whisper-worker.js', 'tts-worker.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('cr-') && k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  // « Partager › Compte-rendu » : on garde le(s) fichier(s) reçu(s) puis on ouvre l'appli qui les traite
  if (e.request.method === 'POST' && u.origin === location.origin && u.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const fd = await e.request.formData();
      const files = fd.getAll('audio').filter((f) => f && f.size);
      const db = await new Promise((res, rej) => { const r = indexedDB.open('cr-share', 1); r.onupgradeneeded = () => r.result.createObjectStore('files', { autoIncrement: true }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      await new Promise((res, rej) => { const t = db.transaction('files', 'readwrite'); files.forEach((f) => t.objectStore('files').add({ name: f.name, type: f.type, lastModified: f.lastModified, at: Date.now(), blob: new Blob([f], { type: f.type }) })); t.oncomplete = res; t.onerror = () => rej(t.error); });
      return Response.redirect('./?shared=' + files.length, 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // API et modèles : non interceptés
  // Fichiers de l'appli : réseau d'abord (mises à jour), cache si hors ligne. Gros fichiers vendor : cache d'abord.
  if (u.pathname.includes('/vendor/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); return r; })));
  } else {
    // no-cache : on revérifie toujours auprès du serveur, pour que les mises à jour arrivent tout de suite
    e.respondWith(fetch(e.request.url, { cache: 'no-cache' }).then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});
