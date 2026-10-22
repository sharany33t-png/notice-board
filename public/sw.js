self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data.json(); } catch (x) {}
  e.waitUntil(self.registration.showNotification((d.urgent ? "\uD83D\uDEA8 " : "\uD83D\uDCCC ") + (d.title || "New notice"), {
    body: (d.category ? d.category + ": " : "") + (d.body || ""),
    tag: d.id || "notice",
    requireInteraction: !!d.urgent
  }));
});
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (l) {
    for (var i = 0; i < l.length; i++) { if ("focus" in l[i]) { l[i].navigate("/#notices"); return l[i].focus(); } }
    return clients.openWindow("/#notices");
  }));
});
