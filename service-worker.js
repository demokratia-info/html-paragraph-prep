"use strict";

const CACHE_PREFIX = "summary-html-desk-";
const CACHE_NAME = `${CACHE_PREFIX}v54`;
const ASSETS = [
  "./",
  "./index.html",
  "./assets/styles.css?v=20260619-2",
  "./assets/app.js?v=20260619-2",
  "./assets/favicon.svg",
  "./manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(ASSETS.map((asset) => new Request(asset, { cache: "no-store" })))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      const oldCacheNames = keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
      await Promise.all(oldCacheNames.map((key) => caches.delete(key)));
      await self.clients.claim();
      if (!oldCacheNames.length) return;
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      await Promise.all(
        clients.map((client) => {
          const url = new URL(client.url);
          if (url.origin !== self.location.origin) return null;
          return client.navigate(client.url).catch(() => null);
        })
      );
    })
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(new Request(request, { cache: "no-store" }))
      .then((response) => {
        if (response.ok && response.status !== 206) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          if (request.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        })
      )
  );
});
