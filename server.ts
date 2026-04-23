import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  // Global Interceptor: Catch leaked requests from the iframe
  app.use((req, res, next) => {
    const isProxyEndpoint = req.url.startsWith('/api/proxy');
    const hasUrlParam = !!req.query.url;
    const isStaticAsset = req.url.startsWith('/@') || req.url.startsWith('/src') || req.url.startsWith('/node_modules') || req.url.startsWith('/index.html');
    
    // If it's a proxy request missing the 'url', OR a leaked direct asset request
    if ((isProxyEndpoint && !hasUrlParam) || (!isProxyEndpoint && !isStaticAsset)) {
      const referer = req.headers.referer;
      if (referer && referer.includes('/api/proxy?url=')) {
        try {
          const refererUrl = new URL(referer);
          let targetEncoded = refererUrl.searchParams.get('url');
          if (targetEncoded) {
            if (!targetEncoded.startsWith('http')) {
               const b64 = targetEncoded.replace(/ /g, '+');
               try { targetEncoded = Buffer.from(b64, 'base64').toString('utf-8'); } catch(e) {}
            }
            if (targetEncoded.startsWith('http')) {
              const baseTarget = new URL(targetEncoded);
              const recoveredUrl = new URL(req.url, baseTarget).href;
              const b64 = Buffer.from(recoveredUrl, 'utf-8').toString('base64');
              console.log(`[Interceptor] Recovered: ${recoveredUrl}`);
              return res.redirect(`/api/proxy?url=${encodeURIComponent(b64)}`);
            }
          }
        } catch (e) {}
      }
    }
    next();
  });

  app.all('/api/proxy', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    let rawUrl = req.query.url;
    if (Array.isArray(rawUrl)) rawUrl = rawUrl[0]; 
    let targetUrl = rawUrl as string;

    if (!targetUrl) return res.status(400).send('URL is required');

    // Decode Base64 if needed
    if (targetUrl && !targetUrl.startsWith('http') && targetUrl.length > 5) {
      try {
        const b64 = targetUrl.trim().replace(/ /g, '+');
        const decoded = Buffer.from(b64, 'base64').toString('utf-8');
        if (decoded.includes('://')) targetUrl = decoded;
      } catch (e) {}
    }

    // Attach other query params (important for Google/Bing forms)
    const queryParams = { ...req.query };
    delete queryParams.url;
    if (Object.keys(queryParams).length > 0) {
      try {
        const urlObj = new URL(targetUrl.startsWith('http') ? targetUrl : 'https://' + targetUrl);
        Object.entries(queryParams).forEach(([k, v]) => urlObj.searchParams.append(k, v as string));
        targetUrl = urlObj.href;
      } catch(e) {}
    }

    try {
      const resolvedUrl = targetUrl.startsWith('http') ? targetUrl : 'https://' + targetUrl;
      const targetBase = new URL(resolvedUrl).origin;

      const proxyHeaders: Record<string, string> = {
        'User-Agent': (req.headers['user-agent'] as string) || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': (req.headers['accept-language'] as string) || 'ja,en-US;q=0.9,en;q=0.8',
        'Referer': resolvedUrl,
        'Origin': targetBase
      };

      // Copy other safe headers
      ['accept', 'content-type', 'cookie'].forEach(h => {
        if (req.headers[h]) proxyHeaders[h] = req.headers[h] as string;
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      const response = await fetch(resolvedUrl, {
        method: req.method,
        headers: proxyHeaders,
        redirect: 'manual',
        body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined,
        signal: controller.signal as any
      });
      clearTimeout(timeoutId);

      const contentType = response.headers.get('content-type') || '';
      res.status(response.status);
      res.set('Content-Type', contentType);

      const isHtml = contentType.includes('text/html');
      const isCss = contentType.includes('text/css');
      const isJs = contentType.includes('javascript') || contentType.includes('x-javascript') || contentType.includes('ecmascript');
      const shouldModify = isHtml || isCss || isJs;

      // Clean headers for framing and privacy
      const strip = [
        'x-frame-options', 'content-security-policy', 'x-content-security-policy', 
        'strict-transport-security', 'content-length', 'content-encoding',
        'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
        'permissions-policy', 'link', 'origin-trial', 'report-to'
      ];
      response.headers.forEach((v, k) => {
        const l = k.toLowerCase();
        if (!strip.includes(l) && l !== 'set-cookie') {
          if (l === 'location') {
            try { res.set(k, `/api/proxy?url=${encodeURIComponent(Buffer.from(new URL(v, resolvedUrl).href).toString('base64'))}`); }
            catch(e) { res.set(k, v); }
          } else { res.set(k, v); }
        }
      });

      // Cookie processing
      // @ts-ignore
      const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : response.headers.get('set-cookie');
      if (cookies) {
         const arr = Array.isArray(cookies) ? cookies : [cookies];
         res.set('Set-Cookie', arr.map(c => c.replace(/Domain=[^;]+;?/gi, '').replace(/Secure/gi, '')));
      }

      if (shouldModify) {
        let text = await response.text();
        const baseProxy = '/api/proxy?url=';
        const wrap = (u: string) => encodeURIComponent(Buffer.from(u, 'utf-8').toString('base64'));

        if (isJs || isHtml) {
           // Patch property getters
           const props = ['pathname', 'hostname', 'host', 'origin', 'href', 'search', 'hash'];
           props.forEach(p => {
              text = text.replace(new RegExp(`window\\.location\\.${p}(?!\\s*=)`, 'g'), `(window.__px_loc?.${p} || window.location.${p})`);
              text = text.replace(new RegExp(`(?<!\\w|\\.)location\\.${p}(?!\\s*=)`, 'g'), `(window.__px_loc?.${p} || window.location.${p})`);
           });
           // Patch property setters
           text = text.replace(/(?<!\w|\.)location\.href\s*=\s*([^;}\n\r]+)/g, (m, val) => `window.__px_loc ? window.__px_loc.doAssign(${val}) : (location.href = ${val})`);
           text = text.replace(/window\.location\.href\s*=\s*([^;}\n\r]+)/g, (m, val) => `window.__px_loc ? window.__px_loc.doAssign(${val}) : (location.href = ${val})`);
           
           // Patch methods
           ['replace', 'assign'].forEach(m => {
              const uMethod = m.charAt(0).toUpperCase() + m.slice(1);
              text = text.replace(new RegExp(`(?<!\\w|\\.)location\\.${m}\\(`, 'g'), `(window.__px_loc?.do${uMethod} || window.location.${m}).call(window.location, `);
              text = text.replace(new RegExp(`window\\.location\\.${m}\\(`, 'g'), `(window.__px_loc?.do${uMethod} || window.location.${m}).call(window.location, `);
           });
           
           // Special: window.location = ... and location = ...
           text = text.replace(/window\.location\s*=\s*([^;}\n\r]+)/g, (m, val) => `window.__px_loc ? window.__px_loc.doAssign(${val}) : (window.location = ${val})`);
           text = text.replace(/(?<!\w|\.)location\s*=\s*((?!(window|this|null|undefined|true|false|0|1|2|3|4|5|6|7|8|9|'|"))[^;}\n\r]+)/g, (m, val) => `window.__px_loc ? window.__px_loc.doAssign(${val}) : (location = ${val})`);
        }

        if (isHtml) {
          // Attribute rewrite
          text = text.replace(/<(?:!--[\s\S]*?--!?>|[^>]+)>/g, (tag) => {
             if (tag.startsWith('<!--')) return tag;
             return tag.replace(/\s(src|href|action)=["']([^"']+)["']/gi, (m, a, v) => {
                if (v.startsWith('data:') || v.startsWith('#') || v.startsWith('javascript:')) return m;
                try { return ` ${a}="${baseProxy}${wrap(new URL(v, resolvedUrl).href)}"`; } catch(e) { return m; }
             });
          });
          // Base strip
          text = text.replace(/<base\s+[^>]*>/gi, '');
          // CSP strip
          text = text.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');

          const injection = `
          <script>
            (function() {
              const targetBase = "${resolvedUrl}";
              const proxyOrigin = window.location.origin;
              
              const b64e = (str) => btoa(unescape(encodeURIComponent(str)));
              const b64d = (str) => decodeURIComponent(escape(atob(str)));

              const wrapUrl = (u) => {
                if (!u || typeof u !== 'string' || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('javascript:')) return u;
                if (u.includes('/api/proxy')) return u;
                try {
                  const abs = new URL(u, window.__px_loc ? window.__px_loc.href : targetBase).href;
                  return proxyOrigin + "/api/proxy?url=" + b64e(abs);
                } catch(e) { return u; }
              };

              window.__px_loc = {
                get _u() {
                   try {
                     const p = new URL(window.location.href).searchParams.get("url");
                     return new URL(p ? (p.startsWith("http") ? p : b64d(p)) : targetBase);
                   } catch(e) { return new URL(targetBase); }
                },
                get pathname() { return this._u.pathname; },
                get hostname() { return this._u.hostname; },
                get host() { return this._u.host; },
                get origin() { return this._u.origin; },
                get search() { return this._u.search; },
                get hash() { return this._u.hash; },
                get href() { return this._u.href; },
                wrapUrl: wrapUrl,
                doReplace: (u) => window.location.replace(wrapUrl(u)),
                doAssign: (u) => window.location.assign(wrapUrl(u))
              };

              // Fix browser APIs
              try {
                if ('serviceWorker' in navigator) {
                   navigator.serviceWorker.register = () => new Promise(() => {});
                }
                Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
                Object.defineProperty(window, 'top', { get: () => window, configurable: true });
                Object.defineProperty(window, 'parent', { get: () => window, configurable: true });
                Object.defineProperty(document, 'domain', { get: () => window.__px_loc.hostname, set: (v) => v, configurable: true });
                Object.defineProperty(document, 'URL', { get: () => window.__px_loc.href, configurable: true });
              } catch(e) {}

              // XHR & Fetch
              const _f = window.fetch;
              window.fetch = (i, o) => _f(typeof i === 'string' ? wrapUrl(i) : (i instanceof Request ? new Request(wrapUrl(i.url), i) : i), o);
              const _o = XMLHttpRequest.prototype.open;
              XMLHttpRequest.prototype.open = function(m, u, ...a) { return _o.call(this, m, wrapUrl(u), ...a); };

              const _op = window.open;
              window.open = (u, ...a) => _op.call(window, wrapUrl(u), ...a);

              const _h = window.history;
              const _ps = _h.pushState;
              const _rs = _h.replaceState;
              _h.pushState = function(s, t, u) { return _ps.call(this, s, t, wrapUrl(u)); };
              _h.replaceState = function(s, t, u) { return _rs.call(this, s, t, wrapUrl(u)); };

              // Form Patching
              const patchForm = (f) => {
                if (f.dataset.p) return;
                f.dataset.p = "1";
                let act = f.getAttribute('action') || window.__px_loc.href;
                const method = (f.getAttribute('method') || 'GET').toUpperCase();
                if (method === 'GET') {
                  try {
                    let u = act.startsWith('/api/proxy') ? new URL(act, proxyOrigin) : new URL(act, window.__px_loc.href);
                    let realAct = u.href;
                    if (u.origin === proxyOrigin && u.pathname === '/api/proxy') {
                       const encoded = u.searchParams.get('url');
                       if (encoded) try { realAct = encoded.startsWith('http') ? encoded : b64d(encoded); } catch(e) { realAct = encoded; }
                    }
                    f.setAttribute('action', proxyOrigin + "/api/proxy");
                    if (!f.querySelector('input[name="url"]')) {
                      const h = document.createElement('input');
                      h.type = 'hidden'; h.name = 'url';
                      const pureActObj = new URL(realAct, targetBase);
                      h.value = b64e(pureActObj.origin + pureActObj.pathname);
                      f.appendChild(h);
                    }
                  } catch(e) {}
                }
              };

              // Mutation Observer
              const observer = new MutationObserver((mutations) => {
                mutations.forEach((m) => {
                  m.addedNodes.forEach((n) => {
                    if (n.nodeType === 1) {
                      if (n.tagName === 'A' && n.hasAttribute('href')) n.href = wrapUrl(n.href);
                      if (n.tagName === 'FORM') patchForm(n);
                      n.querySelectorAll?.('a[href]').forEach(a => a.href = wrapUrl(a.href));
                      n.querySelectorAll?.('form').forEach(patchForm);
                      if (['SCRIPT', 'IMG', 'IFRAME', 'SOURCE'].includes(n.tagName)) {
                         if (n.src && !n.src.includes(proxyOrigin)) n.src = wrapUrl(n.src);
                      }
                    }
                  });
                });
              });
              observer.observe(document.documentElement, { childList: true, subtree: true });
              document.querySelectorAll('form').forEach(patchForm);
              document.querySelectorAll('a[href]').forEach(a => a.href = wrapUrl(a.href));
            })();
          </script>
          `;
          text = text.replace(/<head>/i, '<head>' + injection);
        } else if (isCss) {
           text = text.replace(/url\(["']?([^"')]+)["']?\)/gi, (m, v) => v.startsWith('data:') ? m : `url("${baseProxy}${wrap(new URL(v, resolvedUrl).href)}")`);
        }
        res.send(text);
      } else {
        if (response.body) {
          const { Readable } = await import('stream');
          // @ts-ignore
          Readable.fromWeb(response.body).pipe(res);
        } else {
          res.send(Buffer.from(await response.arrayBuffer()));
        }
      }
    } catch (e: any) {
      res.status(500).send(`Proxy Error: ${e.message}`);
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const v = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(v.middlewares);
  } else {
    const d = path.join(process.cwd(), 'dist');
    app.use(express.static(d));
    app.get('*', (req, res) => res.sendFile(path.join(d, 'index.html')));
  }
  app.listen(PORT, '0.0.0.0', () => console.log(`ShadowProxy running on :${PORT}`));
}
startServer();
