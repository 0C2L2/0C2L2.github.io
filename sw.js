// Service worker: only shows planner reminders pushed by the send-reminders Edge Function. No caching.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Planner', { body: d.body || '', tag: d.tag, renotify: !!d.tag, data: { url: d.url || 'planner.html' } }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url || 'planner.html', self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
    const open = wins.find(w => w.url.includes('planner.html'));
    return open ? open.focus() : clients.openWindow(url);
  }));
});
