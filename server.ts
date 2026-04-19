import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Proxy endpoint
  app.get('/api/proxy', async (req, res) => {
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

      const response = await fetch(resolvedUrl, {
        headers: {
          'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept-Encoding': 'identity',
        },
      });

      const contentType = response.headers.get('content-type') || '';
      
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
        if (!headersToStrip.includes(key.toLowerCase())) {
          res.set(key, value);
        }
      });
      // Explicitly unset frame options just in case
      res.removeHeader('X-Frame-Options');
      res.removeHeader('Content-Security-Policy');

      if (contentType.includes('text/html') || contentType.includes('text/css')) {
        let text = await response.text();
        const base = new URL(resolvedUrl);

        // Basic link rewriting for HTML/CSS
        // Use a relative path for the base URL to ensure it works behind the AI Studio proxy
        const baseUrl = '/api/proxy?url=';
        
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

        // Handle Meta Refresh
        text = text.replace(/<meta http-equiv=["']refresh["'] content=["'](\d+);\s*url=([^"']+)["']/gi, (match, delay, url) => {
          try {
             const absoluteUrl = new URL(url, base).href;
             return `<meta http-equiv="refresh" content="${delay};url=${baseUrl}${encodeURIComponent(absoluteUrl)}">`;
          } catch(e) {
             return match;
          }
        });

        // Inject a comprehensive script to handle dynamic client-side fetches and URL resolution
        if (contentType.includes('text/html')) {
           // Strip subresource integrity attributes which will fail after rewriting
           text = text.replace(/\sintegrity=["'][^"']+["']/gi, '');

           const injection = `
           <script>
             (function() {
               const proxyBase = "${baseUrl}";
               const targetBase = "${resolvedUrl}";
               
               function wrapUrl(url) {
                 if (!url || typeof url !== 'string') return url;
                 if (url.startsWith(proxyBase)) return url;
                 if (url.startsWith('/') && !url.startsWith('//')) {
                    // It's already relative but we need to make it absolute to internal target
                    url = new URL(url, targetBase).href;
                 }
                 if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) return url;
                 
                 try {
                   const absoluteUrl = new URL(url, document.baseURI).href;
                   return proxyBase + encodeURIComponent(absoluteUrl);
                 } catch(e) {
                   return url;
                 }
               }

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
                       if (node.tagName === 'A') node.href = wrapUrl(node.href);
                       if (node.tagName === 'FORM') patchForm(node);
                       node.querySelectorAll?.('a').forEach(a => a.href = wrapUrl(a.href));
                       node.querySelectorAll?.('form').forEach(f => patchForm(f));
                     }
                   });
                 });
               });
               observer.observe(document.documentElement, { childList: true, subtree: true });

               function patchForm(form) {
                 const method = (form.getAttribute('method') || 'GET').toUpperCase();
                 const action = form.getAttribute('action');
                 if (action && !action.startsWith(proxyBase)) {
                   const targetUrl = new URL(action, document.baseURI).href;
                   if (method === 'GET') {
                     let urlInput = form.querySelector('input[name="url"]');
                     if (!urlInput) {
                       urlInput = document.createElement('input');
                       urlInput.setAttribute('type', 'hidden');
                       urlInput.setAttribute('name', 'url');
                       form.appendChild(urlInput);
                     }
                     urlInput.value = targetUrl;
                     form.setAttribute('action', proxyBase.split('=')[0] + '=');
                   } else {
                     form.setAttribute('action', wrapUrl(action));
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
                 if (target && target.href && !target.href.startsWith(proxyBase) && !target.href.startsWith('javascript:') && !target.href.startsWith('#')) {
                   target.href = wrapUrl(target.href);
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
        // For binary data (images, etc.), pipe the stream
        const buffer = await response.arrayBuffer();
        res.send(Buffer.from(buffer));
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
