/**
 * loader.js - Resilient Dependency Loader for Office-Compressor
 * 
 * Automatically loads required third-party libraries from pre-downloaded local paths (`./libs/*.js`)
 * and falls back to pre-defined public CDNs (jsDelivr / cdnjs) on error or network timeout.
 * 
 * Works 100% offline via local files and under direct file execution (file:///) as well as HTTP/S.
 */

(function (window) {
  'use strict';

  const DEPENDENCY_MANIFEST = [
    {
      id: 'jszip',
      name: 'JSZip (ZIP Compression & Modern Office)',
      global: 'JSZip',
      sources: [
        './libs/jszip.min.js',
        'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
      ]
    },
    {
      id: 'xlsx',
      name: 'SheetJS (Legacy XLS Conversion)',
      global: 'XLSX',
      sources: [
        './libs/xlsx.full.min.js',
        'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
      ]
    },
    {
      id: 'cfb',
      name: 'CFB (Compound File Binary / Legacy Doc & PPT)',
      global: 'CFB',
      sources: [
        './libs/cfb.min.js',
        'https://cdn.jsdelivr.net/npm/cfb@1.2.2/dist/cfb.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/cfb/1.2.2/cfb.min.js'
      ]
    },
    {
      id: 'pdf-lib',
      name: 'PDF-Lib (PDF Image Stream Downsampling)',
      global: 'PDFLib',
      sources: [
        './libs/pdf-lib.min.js',
        'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js'
      ]
    },
    {
      id: 'utif',
      name: 'UTIF.js (TIFF Image Decoder)',
      global: 'UTIF',
      sources: [
        './libs/utif.min.js',
        'https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js',
        'https://cdnjs.cloudflare.com/ajax/libs/utif/3.1.0/UTIF.js'
      ]
    },
    {
      id: 'mp4box',
      name: 'MP4Box.js (MP4/MOV Demuxer)',
      global: 'MP4Box',
      sources: [
        './libs/mp4box.all.min.js',
        'https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js'
      ]
    },
    {
      id: 'mp4-muxer',
      name: 'MP4 Muxer (WebCodecs MP4 Output)',
      global: 'Mp4Muxer',
      sources: [
        './libs/mp4-muxer.min.js',
        'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.min.js',
        'https://cdn.jsdelivr.net/npm/mp4-muxer/build/mp4-muxer.js'
      ]
    },
    {
      id: 'webm-muxer',
      name: 'WebM Muxer (WebCodecs MKV/WebM Output)',
      global: 'WebMMuxer',
      sources: [
        './libs/webm-muxer.min.js',
        'https://cdn.jsdelivr.net/npm/webm-muxer@5.0.2/build/webm-muxer.min.js',
        'https://cdn.jsdelivr.net/npm/webm-muxer/build/webm-muxer.js'
      ]
    }
  ];

  class DependencyLoaderManager {
    constructor() {
      this.status = {};
      this.listeners = [];
      this.scriptCache = {};
      this._readyPromise = null;
    }

    onProgress(callback) {
      if (typeof callback === 'function') {
        this.listeners.push(callback);
      }
    }

    emitProgress(data) {
      this.listeners.forEach((fn) => {
        try {
          fn(data);
        } catch (e) {
          console.warn('[Loader] Listener error:', e);
        }
      });
    }

    loadScriptFromUrl(url, timeoutMs = 4000) {
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.type = 'text/javascript';
        script.async = true;

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          script.onerror = null;
          script.onload = null;
          if (script.parentNode) script.parentNode.removeChild(script);
          reject(new Error(`Timeout loading script from: ${url}`));
        }, timeoutMs);

        script.onload = () => {
          if (timedOut) return;
          clearTimeout(timer);
          resolve(url);
        };

        script.onerror = (err) => {
          if (timedOut) return;
          clearTimeout(timer);
          if (script.parentNode) script.parentNode.removeChild(script);
          reject(new Error(`Failed to load script from: ${url}`));
        };

        script.src = url;
        (document.head || document.documentElement).appendChild(script);
      });
    }

    async loadDependency(dep) {
      // If already available on window, mark resolved
      if (window[dep.global]) {
        this.status[dep.id] = { loaded: true, source: 'window', global: dep.global };
        return dep;
      }

      for (let i = 0; i < dep.sources.length; i++) {
        const url = dep.sources[i];
        const isLocal = url.startsWith('./');
        try {
          // Local files load very fast, give 2500ms timeout; CDNs get 4500ms
          const timeout = isLocal ? 2500 : 4500;
          await this.loadScriptFromUrl(url, timeout);

          // Verify global
          if (window[dep.global]) {
            this.status[dep.id] = {
              loaded: true,
              source: isLocal ? 'local' : 'cdn',
              url: url,
              global: dep.global
            };
            this.emitProgress({
              id: dep.id,
              name: dep.name,
              status: 'success',
              source: isLocal ? 'Local Cache' : 'Public CDN',
              url
            });
            return dep;
          } else {
            console.warn(`[Loader] Script ${url} loaded but window.${dep.global} is undefined.`);
          }
        } catch (err) {
          console.warn(`[Loader] Failed source ${url} for ${dep.id}:`, err.message);
        }
      }

      this.status[dep.id] = { loaded: false, error: 'All sources failed' };
      this.emitProgress({
        id: dep.id,
        name: dep.name,
        status: 'error',
        error: 'Failed to load from all sources'
      });
      throw new Error(`Failed to load dependency ${dep.name}`);
    }

    async init() {
      if (this._readyPromise) return this._readyPromise;

      this._readyPromise = (async () => {
        console.log('[Loader] Initializing resilient dependency loader...');
        const results = await Promise.allSettled(
          DEPENDENCY_MANIFEST.map((dep) => this.loadDependency(dep))
        );

        const loadedCount = results.filter((r) => r.status === 'fulfilled').length;
        const totalCount = DEPENDENCY_MANIFEST.length;
        console.log(`[Loader] Loaded ${loadedCount}/${totalCount} libraries.`);

        return {
          total: totalCount,
          loaded: loadedCount,
          manifest: DEPENDENCY_MANIFEST,
          status: this.status
        };
      })();

      return this._readyPromise;
    }

    ready() {
      return this._readyPromise || this.init();
    }
  }

  window.DependencyLoader = new DependencyLoaderManager();
  // Automatically kick off loading as soon as loader.js executes in head
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.DependencyLoader.init();
    });
  } else {
    window.DependencyLoader.init();
  }
})(window);
