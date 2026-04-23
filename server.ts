import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  // Global Interceptor for leaked requests from the iframe
  app.use((req, res, next) => {
    if (req.url.startsWith('/api/proxy') || req.url.startsWith('/@') || req.url.startsWith('/src') || req.url.startsWith('/node_modules')) {
      return next();
    }

    if (req.headers.referer && req.headers.referer.includes('/api/proxy?url=')) {
      try {
        const refererUrl = new URL(req.headers.referer);
        const encodedTargetUrl = refererUrl.searchParams.get('url');
        
        if (encodedTargetUrl) {
          let targetUrl = encodedTargetUrl;
          if (!targetUrl.startsWith('http')) {
            try { 
              const normalized = targetUrl.trim().replace(/ /g, '+');
              targetUrl = Buffer.from(normalized, 'base64').toString('utf-8'); 
            } catch(e) {}
          }
          
          if (targetUrl.startsWith('http')) {
            const baseTarget = new URL(targetUrl);
            const recoveredAbsoluteUrl = new URL(req.url, baseTarget).href;
            const b64 = Buffer.from(recoveredAbsoluteUrl, 'utf-8').toString('base64');
            const absoluteProxyUrl = req.protocol + '://' + req.get('host') + `/api/proxy?url=${encodeURIComponent(b64)}`;
            return res.redirect(absoluteProxyUrl);
          }
        }
      } catch (e) {}
    }
    next();
  });

  app.all('/api/proxy', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    let rawUrl = req.query.url;
    if (Array.isArray(rawUrl)) rawUrl = rawUrl[0]; 
    let targetUrl = rawUrl as string;

    if (!targetUrl) {
      return res.status(400).send('URL is required');
    }

    if (targetUrl.includes('bing.com')) {
      try {
        const urlObj = new URL(targetUrl.startsWith('http') ? targetUrl : 'https://' + targetUrl);
        if (!urlObj.searchParams.has('setlang')) urlObj.searchParams.set('setlang', 'ja');
        if (!urlObj.searchParams.has('cc')) urlObj.searchParams.set('cc', 'JP');
        targetUrl = urlObj.href;
      } catch(e) {}
    }

    if (targetUrl && !targetUrl.startsWith('http') && targetUrl.length > 5) {
      try {
        const normalized = targetUrl.trim().replace(/ /g, '+');
        const decoded = Buffer.from(normalized, 'base64').toString('utf-8');
        if (decoded.match(/^https?:\/\//i) || decoded.startsWith('//')) {
          targetUrl = decoded;
        }
      } catch (e) {}
    }

    const queryParams = { ...req.query };
    delete queryParams.url;
    
    if (Object.keys(queryParams).length > 0) {
      try {
        const urlObj = new URL(targetUrl.startsWith('http') ? targetUrl : 'https://' + targetUrl);
        Object.entries(queryParams).forEach(([key, value]) => {
          urlObj.searchParams.append(key, value as string);
        });
        targetUrl = urlObj.href;
      } catch(e) {}
    }

    try {
      let resolvedUrl = targetUrl;
      if (!resolvedUrl.startsWith('http')) {
        resolvedUrl = 'https://' + resolvedUrl;
      }

      let proxyReferer = resolvedUrl;
      let proxyOrigin = new URL(resolvedUrl).origin;

      if (req.headers.referer && req.headers.referer.includes('/api/proxy?url=')) {
        try {
          const proxyRefUrl = new URL(req.headers.referer);
          let originalRef = proxyRefUrl.searchParams.get('url');
          if (originalRef) {
            if (!originalRef.startsWith('http')) {
              try {
                const normalized = originalRef.trim().replace(/ /g, '+');
                originalRef = Buffer.from(normalized, 'base64').toString('utf-8');
              } catch(e) {}
            }
            if (originalRef && originalRef.startsWith('http')) {
              proxyReferer = originalRef;
              proxyOrigin = new URL(originalRef).origin;
            }
          }
        } catch(e) {}
      }

      const proxyHeaders: Record<string, string> = {};
      Object.entries(req.headers).forEach(([key, value]) => {
        const lowerKey = key.toLowerCase();
        if (!['host', 'connection', 'content-length', 'accept-encoding'].includes(lowerKey)) {
          proxyHeaders[lowerKey] = Array.isArray(value) ? value.join(', ') : (value as string);
        }
      });
      
      if (resolvedUrl.includes('google.com') || resolvedUrl.includes('youtube.com')) {
         proxyHeaders['Accept-Language'] = 'ja,en-US;q=0.9,en;q=0.8';
      }
      
      proxyHeaders['User-Agent'] = (req.headers['user-agent'] as string) || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      proxyHeaders['Referer'] = proxyReferer;
      proxyHeaders['Origin'] = proxyOrigin;
      proxyHeaders['Accept-Encoding'] = 'gzip, deflate'; 
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60 * 1000);

      const fetchOptions: RequestInit = {
        method: req.method,
        headers: proxyHeaders,
        redirect: 'manual',
        signal: controller.signal as any
      };
      
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
        fetchOptions.body = req.body;
      }

      const response = await fetch(resolvedUrl, fetchOptions);
      clearTimeout(timeoutId);

      const contentType = response.headers.get('content-type') || '';
      res.status(response.status);
      res.set('Content-Type', contentType);
      
      const isHtml = contentType.includes('text/html');
      const isCss = contentType.includes('text/css');
      const isJs = contentType.includes('javascript') || contentType.includes('x-javascript') || contentType.includes('ecmascript');
      const shouldModifyBody = isHtml || isCss || isJs;

      const headersToStrip = [
        'x-frame-options', 'content-security-policy', 'x-content-security-policy', 
        'content-security-policy-report-only', 'x-webkit-csp', 'access-control-allow-origin',
        'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
        'permissions-policy', 'expect-ct', 'report-to', 'strict-transport-security'
      ];
      
      if (shouldModifyBody || response.headers.get('content-encoding')) {
        headersToStrip.push('content-length', 'content-encoding', 'transfer-encoding');
      }
      
      response.headers.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        if (!headersToStrip.includes(lowerKey) && lowerKey !== 'set-cookie') {
          if (lowerKey === 'location') {
            try {
              const redirectUrl = new URL(value, resolvedUrl).href;
              const b64 = Buffer.from(redirectUrl, 'utf-8').toString('base64');
              res.set(key, `/api/proxy?url=${encodeURIComponent(b64)}`);
            } catch (e) {
              res.set(key, value);
            }
          } else {
            res.setHeader(key, value);
          }
        }
      });
      
      // @ts-ignore
      const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : response.headers.get('set-cookie');
      if (cookies) {
        const cookieArray = Array.isArray(cookies) ? cookies : [cookies];
        const processedCookies = cookieArray.map((c: string) => c.replace(/Domain=[^;]+;?/gi, '').replace(/Path=[^;]+;?/gi, 'Path=/').replace(/Secure/gi, ''));
        res.set('Set-Cookie', processedCookies);
      }

      if (shouldModifyBody) {
        let text = await response.text();
        const base = new URL(resolvedUrl);
        const baseUrl = '/api/proxy?url=';

        if (isJs || isHtml) {
           const safePatch = (prop: string) => `(window.__px_loc ? window.__px_loc.${prop} : window["location"]["${prop}"])`;
           const noAssign = `(?!\s*=(?!=))`;
           ['pathname', 'hostname', 'host', 'origin', 'href', 'search', 'hash'].forEach(prop => {
              text = text.replace(new RegExp(`window\\.location\\.${prop}${noAssign}`, 'g'), safePatch(prop));
              text = text.replace(new RegExp(`(?<!\\w|\\.)location\\.${prop}${noAssign}`, 'g'), safePatch(prop));
           });
           ['replace', 'assign'].forEach(method => {
              const replacement = `(window.__px_loc ? window.__px_loc.do${method.charAt(0).toUpperCase() + method.slice(1)} : window["location"]["${method}"])`;
              text = text.replace(new RegExp(`(?<!\\w|\\.)location\\.${method}\\(`, 'g'), replacement + '(');
              text = text.replace(new RegExp(`window\\.location\\.${method}\\(`, 'g'), replacement + '(');
           });
           text = text.replace(/(?<!\w|\.)location\.href\s*=\s*([^;}\n\r]+)/g, (m, val) => m.includes('__px_loc') ? m : `window["location"]["href"] = (window.__px_loc ? window.__px_loc.wrapUrl(${val}) : ${val})`);
        }

        function encodeUrlSafeNode(u: string) {
          return encodeURIComponent(Buffer.from(u, 'utf-8').toString('base64'));
        }

        if (isHtml) {
          text = text.replace(/<(?:!--[\s\S]*?--!?>|[^>]+)>/g, (tagMatch) => {
            if (tagMatch.startsWith('<!--')) return tagMatch;
            return tagMatch.replace(/(src|href|action)=["']([^"']+)["']/gi, (match, attr, content) => {
              try {
                if (content.startsWith('data:') || content.startsWith('#') || content.startsWith('javascript:')) return match;
                const absoluteUrl = new URL(content, base).href;
                return `${attr}="${baseUrl}${encodeUrlSafeNode(absoluteUrl)}"`;
              } catch (e) { return match; }
            });
          });
          text = text.replace(/<meta http-equiv=["']refresh["'] content=["'](\d+);\s*url=([^"']+)["']/gi, (match, delay, url) => {
             try { return `<meta http-equiv="refresh" content="${delay};url=${baseUrl}${encodeUrlSafeNode(new URL(url, base).href)}">`; } catch(e) { return match; }
          });
          text = text.replace(/\sintegrity=["'][^"']+["']/gi, '');

          const injection = `
          <script>
            (function() {
              const proxyBase = window.location.origin + "/api/proxy?url=";
              const targetBase = "${resolvedUrl}";
              
              function encodeUrlSafe(u) {
                try { return encodeURIComponent(btoa(encodeURIComponent(u).replace(/%([0-9A-F]{2})/g, (m, p) => String.fromCharCode(parseInt(p, 16))))); } catch(e) { return encodeURIComponent(u); }
              }
              function wrapUrl(url, originalNodeAttr = null) {
                if (!url || typeof url !== 'string' || url.includes(proxyBase) || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) return url;
                try {
                  let u = originalNodeAttr || url;
                  if (u.startsWith('http') && !u.startsWith(window.location.origin)) return proxyBase + encodeUrlSafe(u);
                  const base = window.__px_loc ? window.__px_loc.href : targetBase;
                  return proxyBase + encodeUrlSafe(new URL(u.startsWith(window.location.origin) ? u.substring(window.location.origin.length) : u, base).href);
                } catch(e) { return url; }
              }

              window.__px_loc = {
                get _url() {
                   try {
                      const u = new URL(window.location.href).searchParams.get("url");
                      const real = u && (u.startsWith("http") ? u : decodeURIComponent(escape(atob(u))));
                      return new URL(real || targetBase);
                   } catch(e) { return new URL(targetBase); }
                },
                get pathname() { return this._url.pathname; },
                get hostname() { return this._url.hostname; },
                get host() { return this._url.host; },
                get origin() { return this._url.origin; },
                get search() { return this._url.search; },
                get hash() { return this._url.hash; },
                get href() { return this._url.href; },
                wrapUrl: wrapUrl,
                doReplace: function(url) { window.location.replace(wrapUrl(url)); },
                doAssign: function(url) { window.location.assign(wrapUrl(url)); }
              };

              // Bot Evasion
              try {
                if (typeof navigator !== 'undefined') {
                  Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
                  Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja', 'en-US', 'en'], configurable: true });
                }
                Object.defineProperty(window, 'top', { get: () => window, configurable: true });
                Object.defineProperty(window, 'parent', { get: () => window, configurable: true });
                Object.defineProperty(document, 'domain', { get: () => window.__px_loc.hostname, set: (v) => v, configurable: true });
                Object.defineProperty(document, 'URL', { get: () => window.__px_loc.href, configurable: true });
              } catch(e) {}

              // Fullscreen UI
              (function() {
                const checkBody = setInterval(() => {
                  if (document.body) {
                    clearInterval(checkBody);
                    const btn = document.createElement('div');
                    btn.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;background:rgba(0,0,0,0.6);color:white;padding:5px 12px;border-radius:4px;cursor:pointer;font-family:sans-serif;font-size:13px;backdrop-filter:blur(8px);';
                    btn.innerHTML = 'Fullscreen';
                    btn.onclick = () => {
                      if (!document.fullscreenElement) document.documentElement.requestFullscreen();
                      else document.exitFullscreen();
                    };
                    document.body.appendChild(btn);
                  }
                }, 500);
              })();

              const originalFetch = window.fetch;
              window.fetch = function(input, init) {
                if (typeof input === 'string') input = wrapUrl(input);
                else if (input instanceof Request) input = new Request(wrapUrl(input.url), input);
                return originalFetch.call(this, input, init);
              };
              const originalOpen = XMLHttpRequest.prototype.open;
              XMLHttpRequest.prototype.open = function(m, u, ...a) { return originalOpen.call(this, m, wrapUrl(u), ...a); };

              const observer = new MutationObserver((mutations) => {
                mutations.forEach((m) => {
                  m.addedNodes.forEach((n) => {
                    if (n.nodeType === 1) {
                      if (n.tagName === 'A' && n.hasAttribute('href')) n.href = wrapUrl(n.href, n.getAttribute('href'));
                      n.querySelectorAll?.('a[href]').forEach(a => a.href = wrapUrl(a.href, a.getAttribute('href')));
                    }
                  });
                });
              });
              observer.observe(document.documentElement, { childList: true, subtree: true });

              window.addEventListener('click', function(e) {
                const t = e.target.closest('a');
                if (t && t.hasAttribute('href')) {
                  const h = t.getAttribute('href');
                  if (!h.includes(proxyBase) && !h.startsWith('javascript:') && !h.startsWith('#')) t.href = wrapUrl(t.href, h);
                  t.target = "_self";
                }
              }, true);
            })();
          </script>
          `;
          text = text.replace(/<head>/i, '<head>' + injection);
        } else if (isCss) {
          text = text.replace(/(src|href)=["']([^"']+)["']/gi, (m, attr, val) => `${attr}="${baseUrl}${encodeUrlSafeNode(new URL(val, base).href)}"`);
          text = text.replace(/url\(["']?([^"')]+)["']?\)/gi, (m, val) => `url("${baseUrl}${encodeUrlSafeNode(new URL(val, base).href)}")`);
        }
        res.send(text);
      } else {
        if (response.body) {
          const { Readable } = await import('stream');
          // @ts-ignore
          Readable.fromWeb(response.body).pipe(res);
        } else {
          const buffer = await response.arrayBuffer();
          res.send(Buffer.from(buffer));
        }
      }
    } catch (error: any) {
      res.status(500).send(`Proxy Error: ${error.message}`);
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }
  app.listen(PORT, '0.0.0.0', () => console.log(`ShadowProxy running on http://localhost:${PORT}`));
}

startServer();
