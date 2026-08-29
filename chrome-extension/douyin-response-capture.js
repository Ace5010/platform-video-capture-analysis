(() => {
  const STORE_KEY = '__DOUYIN_MONITOR_PUBLIC_POSTS_V3__';
  const INSTALLED_KEY = '__DOUYIN_MONITOR_CAPTURE_INSTALLED_V3__';
  if (window[INSTALLED_KEY]) return;

  Object.defineProperty(window, INSTALLED_KEY, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const pages = [];
  Object.defineProperty(window, STORE_KEY, {
    value: pages,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const accountKeyFromLocation = () => location.pathname.match(/^\/user\/([^/]+)/)?.[1] || null;
  const isTargetPostRequest = (value) => {
    try {
      const url = new URL(String(value), location.href);
      const pageAccountKey = accountKeyFromLocation();
      return url.origin === location.origin
        && url.pathname === '/aweme/v1/web/aweme/post/'
        && Boolean(pageAccountKey)
        && url.searchParams.get('sec_user_id') === pageAccountKey;
    } catch {
      return false;
    }
  };

  const copyPublicItem = (item) => ({
    aweme_id: item?.aweme_id,
    desc: item?.desc,
    item_title: item?.item_title,
    preview_title: item?.preview_title,
    series_play_info: item?.series_play_info,
    create_time: item?.create_time,
    is_top: item?.is_top,
    statistics: item?.statistics,
    video: item?.video ? {
      duration: item.video.duration,
      cover: item.video.cover,
      origin_cover: item.video.origin_cover,
      dynamic_cover: item.video.dynamic_cover,
    } : null,
    author: item?.author ? {
      nickname: item.author.nickname,
      sec_uid: item.author.sec_uid,
      avatar_thumb: item.author.avatar_thumb,
      avatar_medium: item.author.avatar_medium,
      avatar_larger: item.author.avatar_larger,
    } : null,
  });

  const capture = (requestUrl, payload) => {
    if (!isTargetPostRequest(requestUrl) || !payload || !Array.isArray(payload.aweme_list)) return;
    const page = {
      status_code: payload.status_code,
      has_more: payload.has_more,
      max_cursor: payload.max_cursor,
      aweme_list: payload.aweme_list.map(copyPublicItem),
      captured_at: Date.now(),
    };
    const signature = `${page.max_cursor || 0}:${page.aweme_list.map((item) => item.aweme_id).join(',')}`;
    const existingIndex = pages.findIndex((item) => item.signature === signature);
    const entry = { signature, page };
    if (existingIndex >= 0) pages[existingIndex] = entry;
    else pages.push(entry);
    if (pages.length > 20) pages.splice(0, pages.length - 20);
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    const wrappedFetch = function (...args) {
      const requestUrl = args[0] instanceof Request ? args[0].url : args[0];
      return originalFetch.apply(this, args).then((response) => {
        if (isTargetPostRequest(requestUrl)) {
          response.clone().json().then((payload) => capture(requestUrl, payload)).catch(() => {});
        }
        return response;
      });
    };
    try { Object.defineProperty(wrappedFetch, 'name', { value: originalFetch.name }); } catch { /* optional */ }
    window.fetch = wrappedFetch;
  }

  const requestUrls = new WeakMap();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    requestUrls.set(this, url);
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const requestUrl = requestUrls.get(this);
    if (isTargetPostRequest(requestUrl)) {
      this.addEventListener('loadend', () => {
        try {
          const payload = this.responseType === 'json'
            ? this.response
            : JSON.parse(this.responseText || 'null');
          capture(requestUrl, payload);
        } catch {
          // A failed or non-JSON response is deliberately ignored.
        }
      }, { once: true });
    }
    return originalSend.apply(this, args);
  };
})();
