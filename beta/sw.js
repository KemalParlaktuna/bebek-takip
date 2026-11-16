// Basit servis çalışanı: önce ağ, ağ yoksa son kaydedilen kopya.
// Böylece güncellemeler hemen gelir, internet kesikken uygulama yine açılır.
var CACHE = 'bebek-takip-beta-2';
var SHELL = ['./', 'index.html', 'config.js', 'firebase-app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

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

// Bildirimler (Firebase Cloud Messaging üzerinden gelen web push)
self.addEventListener('push', function(e) {
  var p = {};
  try { p = e.data ? e.data.json() : {}; } catch (err) { p = { data: { body: e.data && e.data.text() } }; }
  var d = p.data || p.notification || p;
  var title = d.title || 'Bebek Takip';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    tag: d.tag || 'bebek-takip',
    renotify: true,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: d.url || './' }
  }));
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf(self.registration.scope) === 0 && 'focus' in list[i]) return list[i].focus();
    }
    return self.clients.openWindow(url);
  }));
});
