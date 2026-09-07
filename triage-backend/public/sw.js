// Service worker mínimo — solo existe para que Chrome/Android consideren instalable la app
// (uno de los requisitos técnicos del navegador). No cachea nada a propósito: el Timeline
// necesita datos siempre frescos del servidor, así que cada pedido pasa directo a la red.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {}); // sin caché — deja pasar todo tal cual a la red
