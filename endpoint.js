/* Public server directory. It never contains invitations or session tokens. */
(() => {
  'use strict';
  function validateOrigin(value) {
    const url = new URL(value);
    if(url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || !/^[a-z0-9-]+\.lhr\.life$/.test(url.hostname)) throw new Error('Неверный адрес телефона.');
    return url.origin;
  }
  function create(config, environment) {
    const {fetch, storage, baseURL, now = Date.now} = environment;
    const directory = new URL(config.endpointDirectory, baseURL);
    if(directory.origin !== new URL(baseURL).origin) throw new Error('Справочник должен находиться рядом с приложением.');
    const key = 'mayak.endpoint:' + config.serverId;
    let origin = validateOrigin(config.apiBaseURL), checked = 0, pending = null;
    try {const previous = storage.getItem(key); if(previous) origin = validateOrigin(previous);} catch(_error) {}
    async function refresh(force = false) {
      if(pending) return pending;
      if(checked && now() - checked < (force ? 10000 : 60000)) return false;
      pending = (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        try {
          const requestURL = new URL(directory); requestURL.searchParams.set('v', String(now()));
          const response = await fetch(requestURL.href, {cache:'no-store', credentials:'omit', signal:controller.signal});
          if(!response.ok) throw new Error('Справочник пока недоступен.');
          const value = await response.json();
          if(value.version !== 1 || value.serverId !== config.serverId) throw new Error('Это другой сервер.');
          const next = validateOrigin(value.apiBaseURL), changed = next !== origin;
          origin = next; checked = now();
          try {storage.setItem(key, origin);} catch(_error) {}
          return changed;
        } finally {clearTimeout(timeout); pending = null;}
      })();
      return pending;
    }
    return {get origin() {return origin;}, refresh};
  }
  const exported = Object.freeze({create, validateOrigin});
  if(typeof module !== 'undefined' && module.exports) module.exports = exported;
  else window.MayakEndpoint = exported;
})();
