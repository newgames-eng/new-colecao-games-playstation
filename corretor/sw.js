const CACHE="new-prof-corretor-v27";
const BASE="/new-colecao-games-playstation/corretor/";
const SHELL=[BASE,BASE+"index.html",BASE+"manifest.webmanifest",BASE+"icon-192.png",BASE+"icon-512.png"];
self.addEventListener("install",e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",e=>{if(e.request.method!=="GET")return;e.respondWith(fetch(e.request).then(r=>{if(r&&r.ok&&new URL(e.request.url).origin===self.location.origin){const x=r.clone();caches.open(CACHE).then(c=>c.put(e.request,x));}return r;}).catch(()=>caches.match(e.request)));});
