"use strict";
/* 应用外壳缓存：断网刷新时仍能从缓存加载页面，
 * 再由应用层从 localStorage 恢复检查单数据与离线队列。
 * API 请求不拦截，直接走网络（失败由应用层离线逻辑处理）。
 */
const CACHE = "hxwl-shell-v2";
const ASSETS = ["/", "/index.html", "/styles.css", "/app.js", "/offline.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return; // 业务数据不缓存
  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ||
        fetch(event.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
          return res;
        })
    )
  );
});
