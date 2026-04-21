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

  // Global Interceptor for leaked requests from the iframe
  // If an un-rewritten relative link is clicked or asset is loaded, it hits the server root (e.g. /category/sound).
  // But the browser will send the proxy URL in the Referer header! We can recover the target and redirect.
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
            return res.redirect(`/api/proxy?url=${encodeURIComponent(b64)}`);
          }
        }
      } catch (e) {
        // Fallthrough if recovery fails
      }
    }
    next();
  });

  // Proxy endpoint handles all HTTP methods (GET, POST, etc.) for AJAX compatibility
  app.all('/api/proxy', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    let targetUrl = req.query.url as string;

    if (!targetUrl) {
      return res.status(400).send('URL is required');
    }

    // Attempt to decode targetUrl as base64 if it does not look like HTTP.
    if (targetUrl && !targetUrl.startsWith('http') && targetUrl.length > 5) {
      try {
        // Express converts '+' to ' ' in query params. We need '+' for base64.
        const normalized = targetUrl.trim().replace(/ /g, '+');
        const decoded = Buffer.from(normalized, 'base64').toString('utf-8');
        if (decoded.startsWith('http')) {
          targetUrl = decoded;
        }
      } catch (e) {
        // Not valid base64
      }
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
        console.error('Fetch error:', networkError);
        return res.status(502).send(`
          <html>
            <body style="font-family: sans-serif; padding: 2rem; background: #111; color: #fff; text-align: center;">
              <h2>Bad Gateway: Could not reach target</h2>
              <p>Target: <b>${resolvedUrl}</b></p>
              <div style="background: #222; padding: 1rem; border-radius: 8px; color: #ff6b6b; font-family: monospace; display: inline-block;">
                ${networkError.message || networkError.toString()}
              </div>
              <p style="margin-top: 2rem; color: #888;">This could be due to a DNS resolution failure, a blocked domain, or the target site refusing the connection.</p>
            </body>
          </html>
        `);
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
        'transfer-encoding',
        'access-control-allow-origin' // Prevent target CORS from interfering with our framing
      ];
      response.headers.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        if (!headersToStrip.includes(lowerKey)) {
          if (lowerKey === 'location') {
            // Rewrite redirects to stay inside the proxy
            try {
              const redirectUrl = new URL(value, resolvedUrl).href;
              const encodedRedirectUrl = Buffer.from(redirectUrl, 'utf-8').toString('base64');
              res.set(key, `/api/proxy?url=${encodeURIComponent(encodedRedirectUrl)}`);
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

      function encodeUrlSafeNode(u: string) {
        try {
           return encodeURIComponent(Buffer.from(u, 'utf-8').toString('base64'));
        } catch(e) {
           return encodeURIComponent(u);
        }
      }

      if (isHtml || isCss || isJs) {
        let text = await response.text();
        const base = new URL(resolvedUrl);
        const baseUrl = '/api/proxy?url=';

        if (isJs || isHtml) {
           // For SPAs (Next.js/React/Bing) we MUST patch their client-side router reading window.location
           // Instead of static strings that break History API (like Bing SERP), we use a dynamic proxy object `__px_loc`
           // We ONLY replace safe properties, using a robust wrapper structure. 
           // We use window['location'] inside the replacement so subsequent regexes don't match it again!
           const safePatch = (prop: string) => `(window.__px_loc ? window.__px_loc.${prop} : window['location'].${prop})`;
           
           // Match property access but avoid left-hand side assignment (e.g. location.href = "..." which would break if replaced to (ternary) = "...")
           const noAssign = `(?!\s*=(?!=))`;
           
           text = text.replace(new RegExp(`window\\.location\\.pathname${noAssign}`, 'g'), safePatch('pathname'));
           text = text.replace(new RegExp(`(?<!\\w|\\.)location\\.pathname${noAssign}`, 'g'), safePatch('pathname'));
           
           text = text.replace(new RegExp(`window\\.location\\.hostname${noAssign}`, 'g'), safePatch('hostname'));
           text = text.replace(new RegExp(`(?<!\\w|\\.)location\\.hostname${noAssign}`, 'g'), safePatch('hostname'));
           
           text = text.replace(new RegExp(`window\\.location\\.host${noAssign}`, 'g'), safePatch('host'));
           text = text.replace(new RegExp(`(?<!\\w|\\.)location\\.host${noAssign}`, 'g'), safePatch('host'));

           text = text.replace(new RegExp(`window\\.location\\.origin${noAssign}`, 'g'), safePatch('origin'));
           text = text.replace(new RegExp(`(?<!\\w|\\.)location\\.origin${noAssign}`, 'g'), safePatch('origin'));
           
           text = text.replace(new RegExp(`window\\.location\\.href${noAssign}`, 'g'), safePatch('href'));
           text = text.replace(new RegExp(`(?<!\\w|\\.)location\\.href${noAssign}`, 'g'), safePatch('href'));
           
           text = text.replace(new RegExp(`window\\.location\\.search${noAssign}`, 'g'), safePatch('search'));
           text = text.replace(new RegExp(`(?<!\\w|\\.)location\\.search${noAssign}`, 'g'), safePatch('search'));
           
           // Intercept location modifications safely without breaking parentheses
           text = text.replace(/(?<!\w|\.)location\.replace\(/g, '(window.__px_loc ? window.__px_loc.doReplace : window["location"].replace)(');
           text = text.replace(/window\.location\.replace\(/g, '(window.__px_loc ? window.__px_loc.doReplace : window["location"].replace)(');
           text = text.replace(/(?<!\w|\.)location\.assign\(/g, '(window.__px_loc ? window.__px_loc.doAssign : window["location"].assign)(');
           text = text.replace(/window\.location\.assign\(/g, '(window.__px_loc ? window.__px_loc.doAssign : window["location"].assign)(');
           
           // Intercept href assignments (e.g. location.href = "...")
           text = text.replace(/(?<!\w|\.)location\.href\s*=\s*(['"][^'"]+['"])/g, 'window["location"].href = (window.__px_loc ? window.__px_loc.wrapUrl($1) : $1)');
           text = text.replace(/window\.location\.href\s*=\s*(['"][^'"]+['"])/g, 'window["location"].href = (window.__px_loc ? window.__px_loc.wrapUrl($1) : $1)');
        }

        if (isHtml || isCss) {
          // Basic link rewriting for HTML/CSS
          // Use a relative path for the base URL to ensure it works behind the AI Studio proxy
          
           if (isHtml) {
           // Regex to find attributes like src="...", href="..." strictly inside HTML tags
            text = text.replace(/<(?:!--[\s\S]*?--!?>|[^>]+)>/g, (tagMatch) => {
               if (tagMatch.startsWith('<!--')) return tagMatch; // Skip comments
               
               // Strip CSP meta tags
               if (tagMatch.match(/http-equiv=["']?Content-Security-Policy["']?/i)) {
                 return '';
               }
               
               return tagMatch.replace(/(src|href|action)=["']([^"']+)["']/gi, (match, attr, content) => {
                 try {
                   // Skip data URIs and anchor links
                   if (content.startsWith('data:') || content.startsWith('#') || content.startsWith('javascript:')) {
                     return match;
                   }
                   
                   const absoluteUrl = new URL(content, base).href;
                   return `${attr}="${baseUrl}${encodeUrlSafeNode(absoluteUrl)}"`;
                 } catch (e) {
                   return match;
                 }
               });
            });
          }

          if (isCss) {
             text = text.replace(/(src|href)=["']([^"']+)["']/gi, (match, attr, content) => {
               try {
                 if (content.startsWith('data:')) return match;
                 const absoluteUrl = new URL(content, base).href;
                 return `${attr}="${baseUrl}${encodeUrlSafeNode(absoluteUrl)}"`;
               } catch (e) {
                 return match;
               }
             });
          }

        // Also handle CSS url(...)
        text = text.replace(/url\(["']?([^"')]+)["']?\)/gi, (match, content) => {
          try {
             if (content.startsWith('data:')) return match;
             const absoluteUrl = new URL(content, base).href;
             return `url("${baseUrl}${encodeUrlSafeNode(absoluteUrl)}")`;
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
               return `<meta http-equiv="refresh" content="${delay};url=${baseUrl}${encodeUrlSafeNode(absoluteUrl)}">`;
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
               
               function encodeUrlSafe(u) {
                  // Double encode to hide from deep packet inspection effectively, or simply base64
                  try {
                     const b64 = btoa(encodeURIComponent(u).replace(/%([0-9A-F]{2})/g, function(match, p1) {
                         return String.fromCharCode(parseInt(p1, 16));
                     }));
                     return encodeURIComponent(b64);
                  } catch(e) {
                     return encodeURIComponent(u); // Fallback
                  }
               }

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
                     return proxyBase + encodeUrlSafe(urlToResolve);
                   }
                   
                   // Resolve relative Paths against the Target domain, not proxy
                   let pathToResolve = urlToResolve;
                   if (pathToResolve.startsWith(window.location.origin)) {
                     pathToResolve = pathToResolve.substring(window.location.origin.length);
                   }
                   
                   const absoluteUrl = new URL(pathToResolve, targetBase).href;
                   return proxyBase + encodeUrlSafe(absoluteUrl);
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
                       if (realUrlParam) {
                          if (!realUrlParam.startsWith('http')) {
                             try {
                                return decodeURIComponent(escape(atob(realUrlParam)));
                             } catch(e) {}
                          }
                          return realUrlParam;
                       }
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
                 // Force _self or explicitly define the proxy URL. Opening in a new tab might escape the app context
                 return originalOpenWindow.call(window, wrapUrl(url), '_self', features);
               };

               // MutationObserver to handle dynamic elements
               const observer = new MutationObserver((mutations) => {
                 mutations.forEach((mutation) => {
                   mutation.addedNodes.forEach((node) => {
                     if (node.nodeType === 1) {
                       if (node.tagName === 'A' && node.hasAttribute('href')) {
                         node.href = wrapUrl(node.href, node.getAttribute('href'));
                         if (node.getAttribute('target') === '_blank') node.setAttribute('target', '_self');
                       }
                       if (node.tagName === 'FORM') patchForm(node);
                       node.querySelectorAll?.('a').forEach(a => {
                         if(a.hasAttribute('href')) {
                           a.href = wrapUrl(a.href, a.getAttribute('href'));
                           if (a.getAttribute('target') === '_blank') a.setAttribute('target', '_self');
                         }
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
                   if (target.getAttribute('target') === '_blank') {
                     target.setAttribute('target', '_self');
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
           
           // OBFUSCATION FOR CONTENT FILTERING BYPASS (Anti-ISGC)
           // If the payload is HTML, we pack it so that deep packet inspection L7 filters
           // cannot read the plaintext HTML (which might contain blocked keywords like "bing").
           const encodedHtml = Buffer.from(text, 'utf-8').toString('base64');
           // Reverse the base64 string to break standard base64 chunk scanners on firewalls
           const reversedB64 = encodedHtml.split('').reverse().join('');
           
           const packedHtml = `<!DOCTYPE html>
           <html lang="en">
           <head>
             <meta charset="UTF-8">
             <title>Secure Gateway</title>
             <script>
               (function(){
                 try {
                   var rev = "${reversedB64}";
                   var b64 = rev.split('').reverse().join('');
                   var bin = atob(b64);
                   var bytes = new Uint8Array(bin.length);
                   for (var i = 0; i < bin.length; i++) {
                       bytes[i] = bin.charCodeAt(i);
                   }
                   var dec = new TextDecoder('utf-8').decode(bytes);
                   document.open();
                   document.write(dec);
                   document.close();
                 } catch(e) {
                   document.body.innerHTML = "Gateway Decode Error: " + e.message;
                 }
               })();
             </script>
           </head>
           <body style="background:#111; color:#fff;">
             <!-- Anti-DPI Obfuscation Frame -->
           </body>
           </html>`;
           
           return res.send(packedHtml);
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
