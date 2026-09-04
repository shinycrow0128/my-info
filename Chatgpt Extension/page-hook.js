/**
 * Runs in the page's own world on chatgpt.com, at document_start.
 *
 * The generated ZIP is not a plain link: clicking the file card makes ChatGPT
 * ask its API for a short-lived signed URL and then hand that to the browser.
 * A content script cannot see that exchange - it lives in an isolated world
 * with its own `fetch` - so this hook wraps the page's own `fetch` and
 * `XMLHttpRequest`, watches for the file-download responses, and forwards the
 * URL over `postMessage`, where `content.js` is listening.
 *
 * It only ever reads; nothing here changes what the page sends or receives.
 */
(() => {
  const FLAG = "__cgapHookInstalled";
  if (window[FLAG]) return;
  window[FLAG] = true;

  const SOURCE = "cgap-page-hook";
  // Both shapes ChatGPT has used for the same thing.
  const FILE_URL_RE = /\/backend-api\/(files|conversation\/[^/]+\/attachment)\//i;

  function post(url, meta) {
    if (!url || typeof url !== "string") return;
    window.postMessage({ source: SOURCE, type: "file-url", url, ...meta }, window.origin);
  }

  /** The download link, wherever this particular response shape keeps it. */
  function harvest(payload) {
    if (!payload || typeof payload !== "object") return;
    const url = payload.download_url || payload.downloadUrl || payload.url;
    post(url, { fileName: payload.file_name || payload.name || "" });
  }

  function absolute(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return "";
    }
  }

  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = nativeFetch.apply(this, args);
    try {
      const request = args[0];
      const url = absolute(typeof request === "string" ? request : request && request.url);
      if (FILE_URL_RE.test(url)) {
        promise
          .then((response) => {
            // Clone, so the page still gets to read its own body.
            const copy = response.clone();
            const type = copy.headers.get("content-type") || "";
            if (type.includes("application/json")) copy.json().then(harvest, () => {});
          })
          .catch(() => {});
      }
    } catch {
      // Never let the hook break a request the page is making.
    }
    return promise;
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__cgapUrl = absolute(url);
    if (FILE_URL_RE.test(this.__cgapUrl)) {
      this.addEventListener("load", () => {
        try {
          const body = this.responseType && this.responseType !== "text" ? this.response : this.responseText;
          harvest(typeof body === "string" ? JSON.parse(body) : body);
        } catch {
          // Not JSON, or not ours - nothing to forward.
        }
      });
    }
    return nativeOpen.call(this, method, url, ...rest);
  };
})();
