/* Only application shell: never cache salary data or API responses. */
const CACHE='ignis-payroll-shell-r02-demo-20261125';
const FILES=['./','./index.html','./app.css','./seed.js','./test-guard.js','./core.js','./exportxlsx.js','./vault.js','./app.js','./boot.js','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin||u.pathname.includes('/api/'))return;
 e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request)));});
