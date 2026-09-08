// Service worker mínimo — solo existe para que Chrome/Android consideren instalable la app
// (uno de los requisitos técnicos del navegador). No cachea nada a propósito: el Timeline
// necesita datos siempre frescos del servidor, así que cada pedido pasa directo a la red.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {}); // sin caché — deja pasar todo tal cual a la red

// Notificaciones push reales del sistema operativo (Fase 5) — el servidor manda el título/
// cuerpo/url ya armados; acá solo se muestran con el ícono de GADUAI (el sonido lo pone el
// sistema operativo por defecto, no se puede personalizar vía Web Push).
self.addEventListener("push", (e) => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(data.titulo || "GADUAI", {
    body: data.cuerpo || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: data.url || "/" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow(e.notification.data.url || "/"));
});
