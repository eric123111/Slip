const CACHE = 'slip-v1'
const SHELL = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)

  // Always fetch API calls from network — never cache them
  if (url.pathname.startsWith('/receipts') ||
      url.pathname.startsWith('/jobs') ||
      url.pathname.startsWith('/email') ||
      url.pathname.startsWith('/auth') ||
      url.pathname.startsWith('/api')) {
    return e.respondWith(fetch(e.request))
  }

  // App shell: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      if (res.ok && e.request.method === 'GET') {
        caches.open(CACHE).then(c => c.put(e.request, res.clone()))
      }
      return res
    }))
  )
})
