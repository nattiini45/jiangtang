/**
 * Inline script that makes an offline fallback page keep its promise to refresh once the
 * connection is back. It must run from the page's own markup: offline, the route's JS chunk is
 * normally not cached, so nothing that needs hydration would ever start.
 *
 * Reloading on the "online" event alone is not enough. The event can fire before the network is
 * usable (Wi-Fi reconnect, captive portal); that reload fails, the placeholder is served again, and
 * no further event follows. So a page that loads while the browser reports itself online schedules
 * its own reload, backing off from 5 s to 60 s. The attempt count lives in sessionStorage to
 * survive those reloads; it starts over once the last attempt is older than any delay plus a slow
 * load, so a later outage in the same tab gets its retries again. Storage that throws leaves only
 * the "online" event, never an endless loop.
 *
 * Plain ES5 in one string: public/sw.js carries a copy for its built-in placeholder (the worker
 * cannot import app modules) and a test runs both against the same scenarios.
 */
export const OFFLINE_RELOAD_SCRIPT =
  '(function(){var K="jt-offline-reload",MAX=8,done=0;' +
  "function go(){if(!done){done=1;location.reload()}}" +
  'window.addEventListener("online",go);' +
  "if(!navigator.onLine)return;" +
  "try{var s=window.sessionStorage,p=(s.getItem(K)||'').split(','),n=+p[0]||0,now=Date.now();" +
  "if(now-(+p[1]||0)>120000)n=0;" +
  "if(n>=MAX)return;" +
  "s.setItem(K,(n+1)+','+now);" +
  "setTimeout(go,Math.min(5000*Math.pow(2,n),60000))}catch(e){}})();";
