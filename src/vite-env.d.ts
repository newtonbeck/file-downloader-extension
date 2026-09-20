/// <reference types="vite/client" />
// TypeScript 6 no longer pulls in every @types package implicitly, so the `chrome` globals used
// by both the panel and the service worker have to be referenced by hand.
/// <reference types="chrome" />
