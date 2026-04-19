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
    const targetUrl = req.query.url as string;

    if (!targetUrl) {
      return res.status(400).send('URL is required');
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
        // This is a naive implementation but works for most simple cases
        // It replaces URLs in src, href attributes
        const baseUrl = `${req.protocol}://${req.get('host')}/api/proxy?url=`;
        
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

               // Patch Image.src, Script.src etc via MutationObserver or accessors if possible
               // For now, let's patch the most common ones
               const proxiedTags = ['img', 'script', 'iframe', 'source', 'video', 'audio', 'link', 'embed', 'object'];
               const originalCreateElement = document.createElement;
               document.createElement = function(tagName, options) {
                 const el = originalCreateElement.call(document, tagName, options);
                 const lowerTag = tagName.toLowerCase();
                 if (proxiedTags.includes(lowerTag)) {
                   const attr = (lowerTag === 'link') ? 'href' : 'src';
                   const originalSet = Object.getOwnPropertyDescriptor(HTMLElement.prototype, attr)?.set || 
                              Object.getOwnPropertyDescriptor(el.constructor.prototype, attr)?.set;
                   
                   if (originalSet) {
                     Object.defineProperty(el, attr, {
                       set: function(val) {
                         return originalSet.call(this, wrapUrl(val));
                       }
                     });
                   }
                 }
                 return el;
               };

               // Handle dynamically added background-images in inline styles
               const originalSetAttribute = Element.prototype.setAttribute;
               Element.prototype.setAttribute = function(name, value) {
                 if (name === 'style' && value.includes('url(')) {
                    value = value.replace(/url\(["']?([^"')]+)["']?\)/gi, (match, content) => {
                      return \`url("\${wrapUrl(content)}")\`;
                    });
                 }
                 return originalSetAttribute.call(this, name, value);
               };

             })();
           </script>
           `;
           text = text.replace('<head>', '<head>' + injection);
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
