import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  // Railway sets process.env.PORT
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  // Proxy endpoint handles all HTTP methods (GET, POST, etc.) for AJAX compatibility
  app.all('/api/proxy', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    let targetUrl = req.query.url as string;

    // Try to recover target URL from Referer if missing from query
    if (!targetUrl && req.headers.referer) {
      try {
        const refererUrl = new URL(req.headers.referer);
        const prevTargetUrl = refererUrl.searchParams.get('url');
        if (prevTargetUrl) {
          // Reconstruct the intended URL by combining previous target base and current query
          const baseTarget = new URL(prevTargetUrl);
          const currentPath = req.url.split('?')[0]; // Likely /api/proxy
          // If the request was for a relative path on the target site
          const queryParams = { ...req.query };
          const newTargetUrl = new URL(baseTarget.origin);
          newTargetUrl.pathname = baseTarget.pathname;
          Object.entries(queryParams).forEach(([key, value]) => {
            newTargetUrl.searchParams.append(key, value as string);
          });
          targetUrl = newTargetUrl.href;
        }
      } catch (e) {
        console.error('Referer recovery failed:', e);
      }
    }

    if (!targetUrl) {
      return res.status(400).send('URL is required');
    }

    // Append other query parameters back to targetUrl
    // This is crucial for forms (like Google Search) that use GET method
    const queryParams = { ...req.query };
    delete queryParams.url;
    
    if (Object.keys(queryParams).length > 0) {
      const urlObj = new URL(targetUrl.startsWith('http') ? targetUrl : 'https://' + targetUrl);
      Object.entries(queryParams).forEach(([key, value]) => {
        urlObj.searchParams.append(key, value as string);
      });
      targetUrl = urlObj.href;
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
          const originalRef = proxyRefUrl.searchParams.get('url');
          if (originalRef) {
            proxyReferer = originalRef;
            proxyOrigin = new URL(originalRef).origin;
          }
        } catch(e) {}
      }

      const proxyHeaders: Record<string, string> = {};
      
      // Copy over all safe headers from the original request
      Object.entries(req.headers).forEach(([key, value]) => {
        const lowerKey = key.toLowerCase();
        if (!['host', 'connection', 'content-length', 'accept-encoding'].includes(lowerKey)) {
          if (Array.isArray(value)) {
            proxyHeaders[lowerKey] = value.join(', ');
          } else if (value) {
            proxyHeaders[lowerKey] = value;
          }
        }
      });
      
      // Guarantee User-Agent, Referer, Origin
      proxyHeaders['User-Agent'] = (req.headers['user-agent'] as string) || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
      proxyHeaders['Referer'] = proxyReferer;
      proxyHeaders['Origin'] = proxyOrigin;
      // We process responses in node, so ask for uncompressed (or let undici handle gzip via auto)
      proxyHeaders['Accept-Encoding'] = 'gzip, deflate'; 
      
      const fetchOptions: RequestInit = {
        method: req.method,
        headers: proxyHeaders,
        redirect: 'manual' // Handle redirects manually if needed, or follow. Undici follows up to 20 by default unless manual
      };
      
      if (req.method !== 'GET' && req.method !== 'HEAD' && Buffer.isBuffer(req.body) && req.body.length > 0) {
        fetchOptions.body = req.body;
      }

      let response;
      try {
        response = await fetch(resolvedUrl, fetchOptions);
      } catch (networkError: any) {
        // Many ad blockers or CDNs simply drop the connection
        return res.status(502).send(`Bad Gateway: Could not reach ${resolvedUrl}`);
      }

      const contentType = response.headers.get('content-type') || '';
      
      // Preserve the specific status code (e.g., 206 Partial Content for videos)
      res.status(response.status);
      
      // Copy essential headers but strip security ones that prevent framing
      res.set('Content-Type', contentType);
      
      // Strip headers that prevent framing, modern security features, or cause encoding issues
      const headersToStrip = [
        'x-frame-options', 
        'content-security-policy', 
        'x-content-security-policy', 
        'content-security-policy-report-only',
        'content-encoding', // Let Express handle compression/encoding
        'content-length',   // Length changes after rewriting
        'transfer-encoding'
      ];
      response.headers.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        if (!headersToStrip.includes(lowerKey)) {
          if (lowerKey === 'location') {
            // Rewrite redirects to stay inside the proxy
            try {
              const redirectUrl = new URL(value, resolvedUrl).href;
              res.set(key, `/api/proxy?url=${encodeURIComponent(redirectUrl)}`);
            } catch (e) {
              res.set(key, value);
            }
          } else {
            res.set(key, value);
          }
        }
      });
      // Explicitly unset frame options just in case
      res.removeHeader('X-Frame-Options');
      res.removeHeader('Content-Security-Policy');

      const isHtml = contentType.includes('text/html');
      const isCss = contentType.includes('text/css');
      const isJs = contentType.includes('javascript') || contentType.includes('x-javascript') || contentType.includes('ecmascript');

      if (isHtml || isCss || isJs) {
        let text = await response.text();
        const base = new URL(resolvedUrl);
        const baseUrl = '/api/proxy?url=';

        if (isJs || isHtml) {
           // For SPAs (Next.js/React/Bing) we MUST patch their client-side router reading window.location
           // Instead of static strings that break History API (like Bing SERP), we use a dynamic proxy object `__px_loc`
           
           // We'll inject `__px_loc` definition in HTML
           text = text.replace(/window\.location\.pathname(?!\s*=(?!=))/g, `(window.__px_loc ? window.__px_loc.pathname : window.location.pathname)`);
           text = text.replace(/(?<!\w|\.)location\.pathname(?!\s*=(?!=))/g, `(window.__px_loc ? window.__px_loc.pathname : location.pathname)`);
           
           text = text.replace(/window\.location\.hostname(?!\s*=(?!=))/g, `(window.__px_loc ? window.__px_loc.hostname : window.location.hostname)`);
           text = text.replace(/(?<!\w|\.)location\.hostname(?!\s*=(?!=))/g, `(window.__px_loc ? window.__px_loc.hostname : location.hostname)`);
           
           text = text.replace(/window\.location\.host(?!\s*=(?!=))/g, `(window.__px_loc ? window.__px_loc.host : window.location.host)`);
           text = text.replace(/(?<!\w|\.)location\.host(?!\s*=(?!=))/g, `(window.__px_loc ? window.__px_loc.host : location.host)`);

           text = text.replace(/window\.location\.origin(?!\s*=(?!=))/g, `(window.__px_loc ? window.__px_loc.origin : window.location.origin)`);
           text = text.replace(/(?<!\w|\.)location\.origin(?!\s*=(?!=))/g, `(window.__px_loc ? window.__px_loc.origin : location.origin)`);
           
           text = text.replace(/window\.location\.href(?!\s*=(?!=))/g, `(window.__px_loc ? window.__px_loc.href : window.location.href)`);
           text = text.replace(/(?<!\w|\.)location\.href(?!\s*=(?!=))/g, `(window.__px_loc ? window.__px_loc.href : location.href)`);
           
           text = text.replace(/window\.location\.search(?!\s*=(?!=))/g, `(window.__px_loc ? window.__px_loc.search : window.location.search)`);
           text = text.replace(/(?<!\w|\.)location\.search(?!\s*=(?!=))/g, `(window.__px_loc ? window.__px_loc.search : location.search)`);
           
           // Intercept location modifications safely without breaking parentheses
           text = text.replace(/(?<!\w|\.)location\.replace\(/g, '(window.__px_loc ? window.__px_loc.doReplace : location.replace)(');
           text = text.replace(/window\.location\.replace\(/g, '(window.__px_loc ? window.__px_loc.doReplace : window.location.replace)(');
           text = text.replace(/(?<!\w|\.)location\.assign\(/g, '(window.__px_loc ? window.__px_loc.doAssign : location.assign)(');
           text = text.replace(/window\.location\.assign\(/g, '(window.__px_loc ? window.__px_loc.doAssign : window.location.assign)(');
           
           // Intercept href assignments (e.g. location.href = "...")
           // We do a best-effort simple regex to catch the most common pattern
           text = text.replace(/(?<!\w|\.)location\.href\s*=\s*(['"][^'"]+['"])/g, 'location.href = (window.__px_loc ? window.__px_loc.wrapUrl($1) : $1)');
           text = text.replace(/window\.location\.href\s*=\s*(['"][^'"]+['"])/g, 'window.location.href = (window.__px_loc ? window.__px_loc.wrapUrl($1) : $1)');
        }

        if (isHtml || isCss) {
          // Basic link rewriting for HTML/CSS
          // Use a relative path for the base URL to ensure it works behind the AI Studio proxy
          
          // Regex to find attributes like src="...", href="..."
          // This targets typical HTML/CSS URL patterns
          text = text.replace(/(src|href|action)=["']([^"']+)["']/gi, (match, attr, content) => {
          try {
            // Skip data URIs and anchor links
            if (content.startsWith('data:') || content.startsWith('#') || content.startsWith('javascript:')) {
              return match;
            }
            
            const absoluteUrl = new URL(content, base).href;
            return `${attr}="${baseUrl}${encodeURIComponent(absoluteUrl)}"`;
          } catch (e) {
            return match;
          }
        });

        // Also handle CSS url(...)
        text = text.replace(/url\(["']?([^"')]+)["']?\)/gi, (match, content) => {
          try {
             if (content.startsWith('data:')) return match;
             const absoluteUrl = new URL(content, base).href;
             return `url("${baseUrl}${encodeURIComponent(absoluteUrl)}")`;
          } catch (e) {
            return match;
          }
        });

        }

        if (isHtml) {
          // Handle Meta Refresh
          text = text.replace(/<meta http-equiv=["']refresh["'] content=["'](\d+);\s*url=([^"']+)["']/gi, (match, delay, url) => {
            try {
               const absoluteUrl = new URL(url, base).href;
               return `<meta http-equiv="refresh" content="${delay};url=${baseUrl}${encodeURIComponent(absoluteUrl)}">`;
            } catch(e) {
               return match;
            }
          });

           // Strip subresource integrity attributes which will fail after rewriting
           text = text.replace(/\sintegrity=["'][^"']+["']/gi, '');

           const injection = `
           <script>
             (function() {
               const proxyBase = "${baseUrl}";
               const targetBase = "${resolvedUrl}";
               const targetUrlObj = new URL(targetBase);
               
               function wrapUrl(url, originalNodeAttr = null) {
                 if (!url || typeof url !== 'string') return url;
                 if (url.includes(proxyBase)) return url;
                 if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('mailto:')) return url;
                 
                 try {
                   // If the URL is already absolute but points to the proxy's origin incorrectly, or if it's relative
                   // we should prefer the raw attribute value to resolve against targetBase
                   let urlToResolve = originalNodeAttr || url;
                   // If it's an absolute URL that doesn't belong to our proxy origin and isn't relative
                   if (urlToResolve.startsWith('http') && !urlToResolve.startsWith(window.location.origin)) {
                     return proxyBase + encodeURIComponent(urlToResolve);
                   }
                   
                   // Resolve relative Paths against the Target domain, not proxy
                   let pathToResolve = urlToResolve;
                   if (pathToResolve.startsWith(window.location.origin)) {
                     pathToResolve = pathToResolve.substring(window.location.origin.length);
                   }
                   
                   const absoluteUrl = new URL(pathToResolve, targetBase).href;
                   return proxyBase + encodeURIComponent(absoluteUrl);
                 } catch(e) {
                   return url;
                 }
               }
               
               // Create dynamic location proxy object
               window.__px_loc = {
                 get pathname() { return targetUrlObj.pathname === '/' ? '/' : targetUrlObj.pathname; },
                 get hostname() { return targetUrlObj.hostname; },
                 get host() { return targetUrlObj.host; },
                 get origin() { return targetUrlObj.origin; },
                 get search() { return targetUrlObj.search; },
                 get href() {
                    // Try to rebuild the original URL if history API changed the proxy url params
                    try {
                       const currentUrl = new URL(window.location.href);
                       const realUrlParam = currentUrl.searchParams.get('url');
                       if (realUrlParam) return realUrlParam;
                    } catch(e) {}
                    return targetBase;
                 },
                 wrapUrl: wrapUrl,
                 doReplace: function(url) { window.location.replace(wrapUrl(url)); },
                 doAssign: function(url) { window.location.assign(wrapUrl(url)); }
               };

               // Patch Fetch
               const originalFetch = window.fetch;
               window.fetch = function(input, init) {
                 if (typeof input === 'string') {
                   input = wrapUrl(input);
                 } else if (input instanceof Request) {
                   const newUrl = wrapUrl(input.url);
                   input = new Request(newUrl, input);
                 }
                 return originalFetch.call(this, input, init);
               };

               // Patch XMLHttpRequest
               const originalOpen = XMLHttpRequest.prototype.open;
               XMLHttpRequest.prototype.open = function(method, url, ...args) {
                 return originalOpen.call(this, method, wrapUrl(url), ...args);
               };

               // Patch document.createElement to catch dynamic scripts, images, and iframes (Crucial for HTML5 games)
               const originalCreateElement = document.createElement;
               document.createElement = function(tagName) {
                 const element = originalCreateElement.call(document, tagName);
                 if (tagName.toLowerCase() === 'script' || tagName.toLowerCase() === 'img' || tagName.toLowerCase() === 'iframe') {
                   const originalSetAttribute = element.setAttribute;
                   element.setAttribute = function(name, value) {
                     if (name === 'src' || name === 'href') {
                       value = wrapUrl(value);
                     }
                     return originalSetAttribute.call(this, name, value);
                   };
                   
                   // Intercept property assignments
                   Object.defineProperty(element, 'src', {
                     set: function(val) {
                       originalSetAttribute.call(this, 'src', wrapUrl(val));
                     },
                     get: function() {
                       return this.getAttribute('src');
                     }
                   });
                 }
                 return element;
               };

               // Patch window.open
               const originalOpenWindow = window.open;
               window.open = function(url, name, features) {
                 return originalOpenWindow.call(window, wrapUrl(url), name, features);
               };

               // MutationObserver to handle dynamic elements
               const observer = new MutationObserver((mutations) => {
                 mutations.forEach((mutation) => {
                   mutation.addedNodes.forEach((node) => {
                     if (node.nodeType === 1) {
                       if (node.tagName === 'A' && node.hasAttribute('href')) {
                         node.href = wrapUrl(node.href, node.getAttribute('href'));
                       }
                       if (node.tagName === 'FORM') patchForm(node);
                       node.querySelectorAll?.('a').forEach(a => {
                         if(a.hasAttribute('href')) a.href = wrapUrl(a.href, a.getAttribute('href'));
                       });
                       node.querySelectorAll?.('form').forEach(f => patchForm(f));
                     }
                   });
                 });
               });
               observer.observe(document.documentElement, { childList: true, subtree: true });

               function patchForm(form) {
                 const method = (form.getAttribute('method') || 'GET').toUpperCase();
                 let action = form.getAttribute('action') || '';
                 let targetFormUrl = targetBase;

                 // If action is already proxied (via HTML regex rewrite), extract the true target
                 if (action.includes(proxyBase)) {
                   try {
                     const urlObj = new URL(action, window.location.origin);
                     targetFormUrl = urlObj.searchParams.get('url') || targetBase;
                   } catch(e) {}
                 } else if (action) {
                   try {
                     targetFormUrl = new URL(action, targetBase).href;
                   } catch(e) {}
                 }

                 if (method === 'GET') {
                   // For GET forms, the browser will strip any query param in the action attribute.
                   // We MUST add the url as a hidden input.
                   let urlInput = form.querySelector('input[name="url"]');
                   if (!urlInput) {
                     urlInput = document.createElement('input');
                     urlInput.setAttribute('type', 'hidden');
                     urlInput.setAttribute('name', 'url');
                     form.prepend(urlInput);
                   }
                   urlInput.value = targetFormUrl;
                   form.setAttribute('action', '/api/proxy'); // Clean proxy endpoint
                 } else {
                   // For POST forms, query parameters in the action URL are preserved.
                   if (action && !action.includes(proxyBase)) {
                     form.setAttribute('action', wrapUrl(form.action, action));
                   }
                 }
               }

               // Patch Form Submissions
               window.addEventListener('submit', function(e) {
                 const form = e.target;
                 if (form.tagName === 'FORM') {
                    patchForm(form);
                 }
               }, true);

               // Intercept all link clicks
               window.addEventListener('click', function(e) {
                 const target = e.target.closest('a');
                 if (target && target.hasAttribute('href')) {
                   const rawHref = target.getAttribute('href');
                   if (!rawHref.includes(proxyBase) && !rawHref.startsWith('javascript:') && !rawHref.startsWith('#')) {
                     target.href = wrapUrl(target.href, rawHref);
                   }
                 }
               }, true);

               // Patch History
               const originalPushState = history.pushState;
               history.pushState = function(state, title, url) {
                 return originalPushState.call(this, state, title, wrapUrl(url));
               };
               const originalReplaceState = history.replaceState;
               history.replaceState = function(state, title, url) {
                 return originalReplaceState.call(this, state, title, wrapUrl(url));
               };

             })();
           </script>
           `;
           // Inject at the beginning of head
           text = text.replace(/<head>/i, '<head>' + injection);
        }

        res.send(text);
      } else {
        // For binary data (images, video, audio), pipe the stream instead of loading all into memory
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
      console.error('Proxy error:', error);
      res.status(500).send(`Proxy Error: ${error.message}`);
    }
  });

  // Vite integration
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ShadowProxy running on http://localhost:${PORT}`);
  });
}

startServer();
