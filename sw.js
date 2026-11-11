// Service worker TanahKu: hanya cache file milik sendiri.
// Data Firebase dan Worker AI (lintas-origin) TIDAK di-cache agar selalu segar.
const CACHE = "tanahku-v4";
const FILES = [
  "./",
  "./tanahsehat_single.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];
const JOURNALS = [
  "./Kompleksitas%20pengaruh%20temperatur%20dan%20kelembaban%20tanah%20terhadap.pdf",
  "./15.%2B319-325%2C%2B909%2C%2BROBBO%2B%26%2BGALIB-N1.pdf",
  "./727-1465-1-SM.pdf",
  "./Evaluasi_Kesesuaian_Lahan_untuk_Tanaman.pdf"
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(FILES);
    const journalResults = await Promise.allSettled(JOURNALS.map((file) => cache.add(file)));
    journalResults.forEach((result, index) => {
      if (result.status === "rejected") {
        console.warn("PDF jurnal belum dapat disimpan untuk akses offline:", JOURNALS[index], result.reason);
      }
    });
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  // network-first: dapat versi terbaru bila online, cache bila offline
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
