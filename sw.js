// Basit servis çalışanı: önce ağ, ağ yoksa son kaydedilen kopya.
// Böylece güncellemeler hemen gelir, internet kesikken uygulama yine açılır.
var CACHE = 'bebek-takip-v2';
var SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', function(e) {
  e.waitUntil(caches.open(CACHE).then(function(c) { return c.addAll(SHELL); }).then(function() { return self.skipWaiting(); }));
});

self.addEventListener('activate', function(e) {
  e.waitUntil(caches.keys().then(function(keys) {
    return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
  }).then(function() { return self.clients.claim(); }));
});

self.addEventListener('fetch', function(e) {
  var req = e.request;
  // Sadece kendi sitemizin GET isteklerine karış; Google ve Apps Script isteklerine dokunma
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(function(res) {
      var copy = res.clone();
      caches.open(CACHE).then(function(c) { c.put(req, copy); });
      return res;
    }).catch(function() {
      return caches.match(req).then(function(r) { return r || caches.match('index.html'); });
    })
  );
});
