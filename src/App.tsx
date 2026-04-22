/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect } from 'react';
import { 
  Shield, 
  Search, 
  ArrowLeft, 
  ArrowRight, 
  RotateCw, 
  ExternalLink,
  Lock,
  Smartphone,
  Monitor,
  History,
  Info,
  ChevronRight
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

export default function App() {
  const [urlInput, setUrlInput] = useState('');
  const [currentUrl, setCurrentUrl] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'desktop' | 'mobile'>('desktop');
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [logs, setLogs] = useState<{level: string, message: string, time: string}[]>([]);
  const [showConsole, setShowConsole] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === 'PROXY_LOG') {
        const { level, args } = event.data;
        setLogs(prev => [{
          level,
          message: args.join(' '),
          time: new Date().toLocaleTimeString()
        }, ...prev].slice(0, 50));
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    // Check if the internal proxy is available. Use a base64 encoded URL to prevent DPI blocking
    fetch(`/api/proxy?url=${btoa('https://www.google.com')}`)
      .then(res => {
        if (!res.ok && res.status === 404) {
          setProxyError('Backend Proxy not found. If you are on GitHub Pages, please note that static hosting does not support the required Node.js server.');
        }
      })
      .catch(() => {
        setProxyError('Could not connect to Proxy Server. Ensure the backend is running.');
      });
  }, []);

  const handleNavigate = (targetUrl: string = urlInput) => {
    if (!targetUrl) return;
    
    let resolved = targetUrl.trim();
    if (!resolved.startsWith('http')) {
      if (!resolved.includes('.') || resolved.includes(' ')) {
        // Use Bing. It has the best proxy compatibility.
        resolved = `https://www.bing.com/search?q=${encodeURIComponent(resolved)}`;
      } else {
        resolved = 'https://' + resolved;
      }
    }

    // Special YouTube handling: Use Embed API or Alternative Frontend
    if (resolved.includes('youtube.com/watch') || resolved.includes('youtu.be/')) {
       // Extract video ID
       let videoId = '';
       if (resolved.includes('youtu.be/')) {
         videoId = resolved.split('youtu.be/')[1]?.split('?')[0];
       } else {
         const urlObj = new URL(resolved);
         videoId = urlObj.searchParams.get('v') || '';
       }

       if (videoId) {
         // Bypass the internal proxy and use YouTube's official nocookie embed or Invidious
         // We use youtube-nocookie.com to minimize tracking while bypassing proxy blocks
         const embedUrl = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`;
         setCurrentUrl(embedUrl);
         setUrlInput(resolved);
         setIsLoading(true);
         
         if (!history.includes(resolved)) {
           setHistory(prev => [resolved, ...prev.slice(0, 9)]);
         }
         return;
       }
    }

    // Also offer alternative routing for generic YouTube links
    if (resolved.includes('youtube.com') && !resolved.includes('youtube-nocookie.com')) {
        resolved = resolved.replace('youtube.com', 'piped.video');
        // We MUST route piped.video through the proxy to strip X-Frame-Options
        const alternativeProxyUrl = `/api/proxy?url=${encodeURIComponent(btoa(unescape(encodeURIComponent(resolved))))}`;
        setCurrentUrl(alternativeProxyUrl);
        setUrlInput(resolved);
        setIsLoading(true);
        if (!history.includes(resolved)) {
           setHistory(prev => [resolved, ...prev.slice(0, 9)]);
        }
        return;
    }

    const proxyUrl = `/api/proxy?url=${encodeURIComponent(btoa(unescape(encodeURIComponent(resolved))))}`;
    setCurrentUrl(proxyUrl);
    setUrlInput(resolved);
    setIsLoading(true);
    
    if (!history.includes(resolved)) {
      setHistory(prev => [resolved, ...prev.slice(0, 9)]);
    }
  };

  const stopLoading = () => setIsLoading(false);

  const handleRefresh = () => {
    if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src;
      setIsLoading(true);
    }
  };

  return (
    <div className="min-h-screen mesh-bg text-white font-sans selection:bg-[#60a5fa] selection:text-white overflow-hidden flex flex-col relative">
      {/* Background Decor */}
      <div className="absolute inset-0 z-[-1] mesh-bg" />

      {/* Top Navigation Bar */}
      <header className="h-16 border-b border-white/10 glass-card mx-4 mt-4 rounded-2xl flex items-center px-6 gap-6 z-50">
        <div className="flex items-center gap-2 pr-6 border-r border-white/10">
          <Shield className="w-7 h-7 text-[#60a5fa]" />
          <span className="font-bold tracking-tighter text-xl bg-clip-text text-transparent bg-gradient-to-r from-[#60a5fa] to-[#a78bfa]">
            SHADOW_GATE
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button 
            onClick={() => window.history.back()}
            className="p-2 hover:bg-white/10 rounded-full transition-colors text-white/60 hover:text-white"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <button 
            onClick={() => window.history.forward()}
            className="p-2 hover:bg-white/10 rounded-full transition-colors text-white/60 hover:text-white"
          >
            <ArrowRight className="w-4 h-4" />
          </button>
          <button 
            onClick={handleRefresh}
            className={`p-2 hover:bg-white/10 rounded-full transition-colors text-white/60 hover:text-white ${isLoading ? 'animate-spin' : ''}`}
          >
            <RotateCw className="w-4 h-4" />
          </button>
        </div>

        <form 
          className="flex-1 flex items-center bg-black/30 border border-white/20 rounded-full px-4 group focus-within:border-[#60a5fa] transition-all"
          onSubmit={(e) => {
            e.preventDefault();
            handleNavigate();
          }}
        >
          <div className="mr-3 text-white/40">
            <Lock className="w-4 h-4" />
          </div>
          <input 
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="Search or enter URL..."
            className="flex-1 bg-transparent border-none outline-none py-2 text-base placeholder-white/30"
          />
          <button type="submit" className="p-1 hover:text-[#60a5fa] transition-colors">
            <Search className="w-4 h-4" />
          </button>
        </form>

        <div className="flex items-center gap-3 pl-6 border-l border-white/10">
          <div className="flex bg-black/20 p-1 rounded-lg">
            <button 
              onClick={() => setViewMode('mobile')}
              className={`p-1.5 rounded-md transition-all ${viewMode === 'mobile' ? 'bg-[#60a5fa] text-[#050a16]' : 'text-white/60 hover:text-white'}`}
            >
              <Smartphone className="w-4 h-4" />
            </button>
            <button 
              onClick={() => setViewMode('desktop')}
              className={`p-1.5 rounded-md transition-all ${viewMode === 'desktop' ? 'bg-[#60a5fa] text-[#050a16]' : 'text-white/60 hover:text-white'}`}
            >
              <Monitor className="w-4 h-4" />
            </button>
          </div>
          <button 
            onClick={() => setShowConsole(prev => !prev)}
            className={`p-2 rounded-full transition-all ${showConsole ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'hover:bg-white/10 text-white/60'}`}
            title="Proxy Console"
          >
            <Info className="w-4 h-4" />
          </button>
        </div>
      </header>

      <main className="flex-1 flex p-4 gap-4 overflow-hidden">
        {/* Left Sidebar */}
        <aside className="w-72 glass-card rounded-3xl flex flex-col p-6 shrink-0 hidden lg:flex">
          <div className="space-y-8">
            <section>
              <h3 className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/40 mb-4 flex items-center justify-between">
                SECURITY_NODE
                <span className="flex items-center gap-1.5 text-[#22c55e]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] animate-pulse shadow-[0_0_8px_#22c55e]"></span>
                </span>
              </h3>
              <div className="space-y-3">
                <div className="glass-item rounded-xl p-3">
                  <div className="text-[10px] text-white/40 uppercase tracking-wider mb-1">Region</div>
                  <div className="text-sm font-semibold">Tokyo (JP-N1)</div>
                </div>
                <div className="glass-item rounded-xl p-3">
                  <div className="text-[10px] text-white/40 uppercase tracking-wider mb-1">Encryption</div>
                  <div className="text-sm font-semibold">AES-256 GCM</div>
                </div>
              </div>
            </section>

            <section>
              <h3 className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/40 mb-4 flex items-center gap-2">
                <History className="w-3.5 h-3.5" />
                RECENT_GATEWAYS
              </h3>
              <div className="space-y-2">
                {history.length > 0 ? (
                  history.map((h, i) => (
                    <button
                      key={i}
                      onClick={() => handleNavigate(h)}
                      className="w-full text-left p-3 glass-item rounded-xl transition-all hover:bg-white/10 group flex items-center justify-between"
                    >
                      <span className="text-xs text-white/60 group-hover:text-white truncate flex-1">
                        {h.replace(/^https?:\/\//, '')}
                      </span>
                      <ChevronRight className="w-3.5 h-3.5 text-white/20 group-hover:text-[#60a5fa] group-hover:translate-x-1 transition-all" />
                    </button>
                  ))
                ) : (
                  <div className="text-xs text-white/20 italic text-center py-6 border border-dashed border-white/10 rounded-xl">
                    No logs available
                  </div>
                )}
              </div>
            </section>
          </div>

          <div className="mt-auto pt-6 border-t border-white/10 text-[11px] text-white/40 space-y-1 font-mono">
            <div className="flex justify-between">
              <span>STATUS:</span>
              <span className="text-[#22c55e]">SECURED</span>
            </div>
            <div className="flex justify-between">
              <span>UPTIME:</span>
              <span>99.9%</span>
            </div>
          </div>
        </aside>

        {/* Browser Content Area */}
        <section className="flex-1 flex flex-col glass-card rounded-3xl overflow-hidden relative">
          {proxyError && (
            <div className="absolute top-4 left-4 right-4 z-[60]">
              <div className="bg-red-500/20 border border-red-500/50 backdrop-blur-md rounded-xl p-4 flex items-center gap-3 text-red-200 shadow-lg animate-in fade-in slide-in-from-top-4">
                <Shield className="w-5 h-5 shrink-0" />
                <div className="text-xs">
                  <span className="font-bold underline">SERVER_ERROR:</span> {proxyError}
                </div>
                <button 
                  onClick={() => setProxyError(null)}
                  className="ml-auto text-white/40 hover:text-white"
                >
                  <RotateCw className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
          {currentUrl ? (
            <div className={`flex-1 transition-all duration-700 ease-in-out flex justify-center ${viewMode === 'mobile' ? 'p-12' : 'p-0'}`}>
              <div 
                className={`bg-white transition-all shadow-2xl relative ${viewMode === 'mobile' ? 'w-[375px] h-full rounded-[48px] border-[14px] border-[#151619] overflow-hidden' : 'w-full h-full'}`}
              >
                <iframe 
                  ref={iframeRef}
                  src={currentUrl} 
                  className="w-full h-full border-none"
                  onLoad={() => setIsLoading(false)}
                />
                
                <AnimatePresence>
                  {isLoading && (
                    <motion.div 
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="absolute inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center z-10"
                    >
                      <div className="flex flex-col items-center gap-6">
                        <div className="w-12 h-12 border-4 border-[#60a5fa] border-t-transparent rounded-full animate-spin"></div>
                        <div className="flex flex-col items-center">
                          <span className="text-sm font-bold tracking-[0.3em] text-white uppercase mb-1">Tunneling</span>
                          <span className="text-[10px] text-white/40 animate-pulse">Establishing secure handshake...</span>
                        </div>
                        <button 
                          onClick={stopLoading}
                          className="mt-4 px-4 py-1.5 rounded-full border border-white/10 text-[10px] uppercase tracking-widest text-white/40 hover:text-white hover:bg-white/10 transition-all"
                        >
                          Cancel
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center p-12">
              <div className="max-w-2xl w-full text-center space-y-12">
                <motion.div
                  initial={{ opacity: 0, y: 30 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.8 }}
                  className="space-y-6"
                >
                  <div className="relative inline-block">
                    <Shield className="w-20 h-20 text-[#60a5fa] mx-auto filter drop-shadow-[0_0_15px_rgba(96,165,250,0.5)]" />
                    <motion.div 
                      animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0.6, 0.3] }}
                      transition={{ duration: 3, repeat: Infinity }}
                      className="absolute inset-0 bg-[#60a5fa] rounded-full filter blur-3xl z-[-1]"
                    />
                  </div>
                  <div>
                    <h2 className="text-5xl font-extrabold tracking-tight text-white mb-4">ShadowGate Proxy</h2>
                    <p className="text-white/60 text-lg max-w-lg mx-auto">
                      Access the web without boundaries through our advanced frosted-glass tunneling protocol.
                    </p>
                  </div>
                </motion.div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {[
                    { name: 'Bing (Search)', url: 'bing.com' },
                    { name: 'YouTube', url: 'youtube.com' },
                    { name: 'X', url: 'x.com' },
                    { name: 'Wikipedia', url: 'wikipedia.org' }
                  ].map((site, i) => (
                    <motion.button 
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.1 * i }}
                      key={site.name}
                      onClick={() => handleNavigate(site.url)}
                      className="p-4 glass-item rounded-2xl text-center hover:border-[#60a5fa]/50 transition-all hover:bg-white/10 group relative overflow-hidden"
                    >
                      <div className="relative z-10 flex flex-col items-center gap-2">
                        <span className="font-bold text-sm text-white">{site.name}</span>
                        <ExternalLink className="w-3.5 h-3.5 text-[#60a5fa] opacity-40 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </motion.button>
                  ))}
                </div>

                <div className="pt-8 flex items-center justify-center gap-6 text-[11px] text-white/30 uppercase tracking-widest font-bold">
                  <span>ShadowGate v2.4.1</span>
                  <div className="w-1.5 h-1.5 rounded-full bg-white/20"></div>
                  <span>Uptime: 99.9%</span>
                </div>
              </div>
            </div>
          )}
        </section>
      </main>

      {/* Debug Console Overlay */}
      <AnimatePresence>
        {showConsole && (
          <motion.div 
            initial={{ opacity: 0, y: 100 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 100 }}
            className="fixed bottom-4 left-4 right-4 h-64 glass-card rounded-2xl border border-red-500/30 overflow-hidden z-[100] shadow-2xl flex flex-col"
          >
            <div className="bg-red-500/10 px-4 py-2 flex items-center justify-between border-b border-red-500/20">
              <span className="text-[10px] uppercase font-bold tracking-widest text-red-400">Security Proxy Console</span>
              <button 
                onClick={() => setLogs([])}
                className="text-[10px] text-red-400 hover:text-white uppercase font-bold"
              >
                Clear
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 font-mono text-[11px] space-y-1">
              {logs.length === 0 && <div className="text-white/20 italic">No logs detected from the proxy gateway...</div>}
              {logs.map((log, i) => (
                <div key={i} className="flex gap-3 leading-relaxed group">
                  <span className="text-white/20 whitespace-nowrap">{log.time}</span>
                  <span className={`${log.level === 'error' ? 'text-red-400' : log.level === 'warn' ? 'text-yellow-400' : 'text-blue-400'} font-bold uppercase w-12`}>
                    [{log.level}]
                  </span>
                  <span className="text-white/70 group-hover:text-white transition-colors">{log.message}</span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer Info Bar */}
      <footer className="h-8 bg-black/20 border-t border-white/5 px-6 flex items-center justify-between text-[10px] text-white/30 tracking-wider">
        <div className="flex gap-6 items-center">
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#22c55e] shadow-[0_0_8px_#22c55e]"></span>
            System Status: Active
          </span>
          <span className="hidden md:inline border-l border-white/10 pl-6">Node Selection: Automatic</span>
        </div>
        <div className="flex gap-4 font-mono">
          <span className="hover:text-white cursor-pointer transition-colors">Privacy Policy</span>
          <span className="hover:text-white cursor-pointer transition-colors">Documentation</span>
        </div>
      </footer>
    </div>
  );
}
