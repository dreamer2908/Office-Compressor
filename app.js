/**
 * app.js - Enterprise UI Logic, Preset Mapping, Codec Detection & Batch Queue Manager
 * 
 * Manages client-side compression pipeline:
 * - Dynamic hardware codec detection via VideoEncoder.isConfigSupported()
 * - Concurrency control: strict sequential lock for videos, parallel workers for images/docs
 * - Presets: Email Strict (<10MB), Email Standard (<25MB), Screen Presentation, Custom Mode
 * - Batch queue table, drag-and-drop folder traversal, ZIP archiving, and visual comparison
 * - Automatic URL cleanup and memory reclamation
 */

(function () {
  'use strict';

  // Preset Configurations
  const PRESETS = {
    'email-strict': {
      name: 'Email Strict (< 10 MB)',
      description: 'Maximum compression for strict email server limits (Exchange/Outlook 10MB cap)',
      audio: {
        mode: 'aac',
        bitrate: 64000,
        channels: 'stereo'
      },
      video: {
        resolution: '480p',
        fps: 15,
        rateControl: 'qualityFactor',
        qualityFactor: 'low', // 0.05
        codec: 'avc1.42E01E',
        audioMode: 'aac',
        audioBitrate: 64000,
        audioChannels: 'stereo',
        container: 'mp4'
      },
      image: {
        format: 'auto',
        maxBoundingBox: { width: 1280, height: 720 },
        quality: 60
      },
      doc: {
        stripMetadata: true
      }
    },
    'email-standard': {
      name: 'Email Standard (< 25 MB)',
      description: 'Balanced high compression for standard email attachments (Gmail, Outlook 25MB cap)',
      audio: {
        mode: 'aac',
        bitrate: 96000,
        channels: 'stereo'
      },
      video: {
        resolution: '720p',
        fps: 15,
        rateControl: 'qualityFactor',
        qualityFactor: 'good', // 0.08
        codec: 'avc1.4D401F',
        audioMode: 'aac',
        audioBitrate: 96000,
        audioChannels: 'stereo',
        container: 'mp4'
      },
      image: {
        format: 'auto',
        maxBoundingBox: { width: 1920, height: 1080 },
        quality: 75
      },
      doc: {
        stripMetadata: true
      }
    },
    'screen-presentation': {
      name: 'Screen Presentation',
      description: 'Optimized for high-fidelity 1080p screen viewing, slides, and crisp UI screenshots',
      audio: {
        mode: 'aac',
        bitrate: 128000,
        channels: 'stereo'
      },
      video: {
        resolution: '1080p',
        fps: 'original',
        rateControl: 'qualityFactor',
        qualityFactor: 'high', // 0.10
        codec: 'avc1.4D401F',
        audioMode: 'passthrough',
        audioBitrate: 128000,
        audioChannels: 'original',
        container: 'mp4'
      },
      image: {
        format: 'auto',
        maxBoundingBox: { width: 1920, height: 1080 },
        quality: 85
      },
      doc: {
        stripMetadata: true
      }
    },
    'custom': {
      name: 'Custom Configuration',
      description: 'Fine-grained control over codecs, resolutions, framerates, and bitrates'
    }
  };

  // State Management
  const state = {
    currentPreset: 'email-standard',
    theme: localStorage.getItem('oc_theme') || 'dark',
    queue: [],
    isProcessing: false,
    activeWorkers: 0,
    supportedCodecs: [],
    createdObjectUrls: new Set()
  };

  // Utility: Format bytes into human-readable strings
  function formatBytes(bytes, decimals = 1) {
    if (bytes === 0 || bytes === null || isNaN(bytes)) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  // Utility: Track and register Object URLs for GC
  function createManagedUrl(blob) {
    const url = URL.createObjectURL(blob);
    state.createdObjectUrls.add(url);
    return url;
  }

  function revokeManagedUrl(url) {
    if (url && state.createdObjectUrls.has(url)) {
      URL.revokeObjectURL(url);
      state.createdObjectUrls.delete(url);
    }
  }

  // Categorize file by extension
  function getFileTypeInfo(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'pdf'].includes(ext)) {
      let icon = '📄';
      if (['docx', 'doc'].includes(ext)) icon = '📝';
      else if (['pptx', 'ppt'].includes(ext)) icon = '📊';
      else if (['xlsx', 'xls'].includes(ext)) icon = '📈';
      else if (ext === 'pdf') icon = '📑';
      return { category: 'document', ext, icon, label: ext.toUpperCase() };
    }
    if (['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'gif', 'avif'].includes(ext)) {
      return { category: 'image', ext, icon: '🖼️', label: ext.toUpperCase() };
    }
    if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'mts', 'm2ts', 'ts', 'flv'].includes(ext)) {
      return { category: 'video', ext, icon: '🎬', label: ext.toUpperCase() };
    }
    if (['m4a', 'mp3', 'wav', 'aac', 'ogg', 'oga', 'flac', 'opus', 'wma'].includes(ext)) {
      return { category: 'audio', ext, icon: '🎵', label: ext.toUpperCase() };
    }
    return { category: 'unknown', ext, icon: '📦', label: ext.toUpperCase() };
  }

  // DOM Elements
  const DOM = {};

  function initDomReferences() {
    DOM.themeToggle = document.getElementById('theme-toggle');
    DOM.dropzone = document.getElementById('dropzone');
    DOM.fileInput = document.getElementById('file-input');
    DOM.presetCards = document.querySelectorAll('.preset-card');
    DOM.customAccordion = document.getElementById('custom-accordion');
    DOM.queueContainer = document.getElementById('queue-container');
    DOM.queueTableBody = document.getElementById('queue-tbody');
    DOM.globalProgress = document.getElementById('global-progress');
    DOM.globalProgressBar = document.getElementById('global-progress-bar');
    DOM.globalStatusText = document.getElementById('global-status-text');
    DOM.totalSavedBadge = document.getElementById('total-saved-badge');
    DOM.btnStartBatch = document.getElementById('btn-start-batch');
    DOM.btnDownloadAll = document.getElementById('btn-download-all');
    DOM.btnClearQueue = document.getElementById('btn-clear-queue');
    DOM.depStatusPill = document.getElementById('dep-status-pill');
    DOM.codecSelect = document.getElementById('custom-video-codec');

    // Custom controls
    DOM.customVideoRes = document.getElementById('custom-video-res');
    DOM.customVideoFps = document.getElementById('custom-video-fps');
    DOM.customRateControl = document.getElementById('custom-rate-control');
    DOM.customQualityFactor = document.getElementById('custom-quality-factor');
    DOM.customExactBitrate = document.getElementById('custom-exact-bitrate');
    DOM.customTargetSize = document.getElementById('custom-target-size');
    DOM.customAudioMode = document.getElementById('custom-audio-mode');
    DOM.customAudioBitrate = document.getElementById('custom-audio-bitrate');
    DOM.customAudioChannels = document.getElementById('custom-audio-channels');
    DOM.customContainer = document.getElementById('custom-container');

    DOM.customImgFormat = document.getElementById('custom-img-format');
    DOM.customImgQuality = document.getElementById('custom-img-quality');
    DOM.customImgQualityVal = document.getElementById('custom-img-quality-val');
    DOM.customImgRes = document.getElementById('custom-img-res');

    // Comparison modal
    DOM.compareModal = document.getElementById('compare-modal');
    DOM.modalClose = document.getElementById('modal-close');
    DOM.modalTitle = document.getElementById('modal-title');
    DOM.modalOriginalMeta = document.getElementById('modal-orig-meta');
    DOM.modalCompressedMeta = document.getElementById('modal-comp-meta');
    DOM.modalOrigPreview = document.getElementById('modal-orig-preview');
    DOM.modalCompPreview = document.getElementById('modal-comp-preview');
  }

  // Theme Management
  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('oc_theme', theme);
    if (DOM.themeToggle) {
      DOM.themeToggle.textContent = theme === 'dark' ? '☀️ Light' : '🌙 Dark';
    }
  }

  // Dynamic Hardware Codec Detection
  async function detectCodecs() {
    const processor = window.MediaProcessor || window.VideoProcessor;
    if (processor && processor.testSupportedCodecs) {
      state.supportedCodecs = await processor.testSupportedCodecs();
      if (DOM.codecSelect) {
        DOM.codecSelect.innerHTML = '';
        if (state.supportedCodecs.length === 0) {
          DOM.codecSelect.innerHTML = '<option value="avc1.4D401F">AVC / H.264 (Default)</option>';
        } else {
          state.supportedCodecs.forEach((c) => {
            const opt = document.createElement('option');
            opt.value = c.codec;
            opt.textContent = `${c.name} (${c.hardwareAcceleration || 'Supported'})`;
            DOM.codecSelect.appendChild(opt);
          });
        }
      }
    }
  }

  // Preset Selection
  function selectPreset(presetKey) {
    state.currentPreset = presetKey;
    DOM.presetCards.forEach((card) => {
      if (card.dataset.preset === presetKey) {
        card.classList.add('active');
      } else {
        card.classList.remove('active');
      }
    });

    if (presetKey === 'custom') {
      DOM.customAccordion.classList.remove('hidden');
    } else {
      DOM.customAccordion.classList.add('hidden');
    }
  }

  // Retrieve Effective Options based on active preset or custom settings
  function getEffectiveOptions() {
    if (state.currentPreset !== 'custom') {
      const preset = PRESETS[state.currentPreset];
      const audioMode = preset.audio ? preset.audio.mode : preset.video.audioMode;
      const audioBitrate = preset.audio ? preset.audio.bitrate : preset.video.audioBitrate;
      const audioChannels = preset.audio ? preset.audio.channels : (preset.video.audioChannels || 'stereo');

      return {
        audioOptions: {
          audioMode,
          audioBitrate,
          audioChannels
        },
        videoOptions: {
          targetResolution: preset.video.resolution,
          targetFps: preset.video.fps,
          rateControl: preset.video.rateControl,
          qualityFactor: preset.video.qualityFactor,
          codec: preset.video.codec,
          audioMode,
          audioBitrate,
          audioChannels,
          container: preset.video.container
        },
        imageOptions: {
          requestedFormat: preset.image.format,
          maxBoundingBox: preset.image.maxBoundingBox,
          quality: preset.image.quality
        },
        stripMetadata: preset.doc.stripMetadata
      };
    }

    // Custom mode values
    const rateControl = DOM.customRateControl.value;
    const audioMode = DOM.customAudioMode.value;
    const audioBitrate = Number(DOM.customAudioBitrate.value);
    const audioChannels = DOM.customAudioChannels ? DOM.customAudioChannels.value : 'stereo';

    return {
      audioOptions: {
        audioMode,
        audioBitrate,
        audioChannels
      },
      videoOptions: {
        targetResolution: DOM.customVideoRes.value,
        targetFps: DOM.customVideoFps.value === 'original' ? 'original' : Number(DOM.customVideoFps.value),
        rateControl,
        qualityFactor: DOM.customQualityFactor.value,
        exactBitrate: Number(DOM.customExactBitrate.value),
        targetSizeBytes: Number(DOM.customTargetSize.value) * 1024 * 1024,
        codec: DOM.codecSelect.value || 'avc1.4D401F',
        audioMode,
        audioBitrate,
        audioChannels,
        container: DOM.customContainer.value
      },
      imageOptions: {
        requestedFormat: DOM.customImgFormat.value,
        quality: Number(DOM.customImgQuality.value),
        maxBoundingBox: DOM.customImgRes.value === 'original' ? null
          : (DOM.customImgRes.value === '1080p' ? { width: 1920, height: 1080 }
          : (DOM.customImgRes.value === '720p' ? { width: 1280, height: 720 }
          : { width: 854, height: 480 }))
      },
      stripMetadata: true
    };
  }

  // Queue Management
  function addToQueue(files) {
    let addedCount = 0;
    Array.from(files).forEach((file) => {
      const typeInfo = getFileTypeInfo(file.name);
      if (typeInfo.category === 'unknown') {
        console.warn(`[Queue] Unsupported format for file: ${file.name}`);
        return;
      }

      const item = {
        id: 'item_' + Math.random().toString(36).substr(2, 9),
        file,
        name: file.name,
        typeInfo,
        originalSize: file.size,
        compressedSize: null,
        status: 'queued', // 'queued' | 'processing' | 'completed' | 'error'
        progress: 0,
        phase: 'Ready',
        resultBlob: null,
        resultUrl: null,
        finalName: file.name,
        error: null
      };

      state.queue.push(item);
      addedCount++;
    });

    if (addedCount > 0) {
      renderQueueTable();
      updateGlobalStats();
    }
  }

  // Batch Directory Reader handling 100-file pagination
  async function readAllDirectoryEntries(dirReader) {
    const allEntries = [];
    let readMore = true;
    while (readMore) {
      const batch = await new Promise((resolve) => {
        dirReader.readEntries((entries) => resolve(entries || []), () => resolve([]));
      });
      if (batch && batch.length > 0) {
        allEntries.push(...batch);
      } else {
        readMore = false;
      }
    }
    return allEntries;
  }

  // Modern File System Access API recursive handle reader (supports file:/// and HTTP/S)
  async function readFileSystemHandle(handle) {
    if (!handle) return [];
    if (handle.kind === 'file') {
      try {
        const file = await handle.getFile();
        return file ? [file] : [];
      } catch (e) {
        return [];
      }
    } else if (handle.kind === 'directory') {
      const files = [];
      try {
        for await (const entry of handle.values()) {
          const subFiles = await readFileSystemHandle(entry);
          files.push(...subFiles);
        }
      } catch (e) {}
      return files;
    }
    return [];
  }

  // Recursive Directory / Folder Drop Traversal (Legacy webkitGetAsEntry fallback)
  async function traverseFileTree(item) {
    if (!item) return [];
    if (item.isFile) {
      return new Promise((resolve) => {
        item.file(
          (file) => resolve([file]),
          () => resolve([])
        );
      });
    } else if (item.isDirectory) {
      try {
        const dirReader = item.createReader();
        const entries = await readAllDirectoryEntries(dirReader);
        const nestedFiles = await Promise.all(
          entries.map((childEntry) => traverseFileTree(childEntry))
        );
        return nestedFiles.flat();
      } catch (e) {
        return [];
      }
    }
    return [];
  }

  async function handleDropEvent(e) {
    e.preventDefault();
    e.stopPropagation();
    DOM.dropzone.classList.remove('drag-over');

    // CRITICAL: Synchronously extract all entries/files before any async/await
    // In Chromium/WebKit, e.dataTransfer is emptied/protected across microtask yields!
    const directFiles = [];
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      directFiles.push(...Array.from(e.dataTransfer.files));
    }

    const handlePromises = [];
    const webkitEntries = [];

    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      for (let i = 0; i < e.dataTransfer.items.length; i++) {
        const item = e.dataTransfer.items[i];
        if (item.kind === 'file') {
          // Direct File extraction (works reliably on file:/// and HTTP/S)
          const f = item.getAsFile ? item.getAsFile() : null;
          if (f && !directFiles.some((df) => df.name === f.name && df.size === f.size)) {
            directFiles.push(f);
          }
          // File System Access API (modern standard: directory traversal on file:/// and HTTP/S)
          if (typeof item.getAsFileSystemHandle === 'function') {
            try {
              const hp = item.getAsFileSystemHandle();
              if (hp) handlePromises.push(hp);
            } catch (err) {}
          }
          // webkitGetAsEntry (legacy fallback for older browsers)
          if (typeof item.webkitGetAsEntry === 'function') {
            try {
              const entry = item.webkitGetAsEntry();
              if (entry) webkitEntries.push(entry);
            } catch (err) {}
          }
        }
      }
    }

    let collectedFiles = [];

    // Strategy 1: Modern File System Access API handles (supports directories on file:/// and HTTP/S)
    if (handlePromises.length > 0) {
      try {
        const handles = (await Promise.all(handlePromises)).filter(Boolean);
        if (handles.length > 0) {
          const handleResults = await Promise.all(handles.map((h) => readFileSystemHandle(h)));
          collectedFiles = handleResults.flat().filter(Boolean);
        }
      } catch (err) {
        console.warn('[Drop] FileSystemHandle processing warning:', err);
      }
    }

    // Strategy 2: Legacy webkitGetAsEntry (for browsers without FileSystemHandle)
    if (collectedFiles.length === 0 && webkitEntries.length > 0) {
      try {
        const entryResults = await Promise.all(webkitEntries.map((entry) => traverseFileTree(entry)));
        collectedFiles = entryResults.flat().filter(Boolean);
      } catch (err) {
        console.warn('[Drop] webkitGetAsEntry processing warning:', err);
      }
    }

    // Strategy 3: Direct File objects fallback (guaranteed on file:/// and standard file drops)
    if (collectedFiles.length === 0 && directFiles.length > 0) {
      collectedFiles = directFiles;
    }

    if (collectedFiles.length > 0) {
      addToQueue(collectedFiles);
    }
  }

  // Render Batch Queue Table
  function renderQueueTable() {
    if (state.queue.length === 0) {
      DOM.queueContainer.classList.add('hidden');
      DOM.queueTableBody.innerHTML = '';
      return;
    }

    DOM.queueContainer.classList.remove('hidden');
    DOM.queueTableBody.innerHTML = '';

    state.queue.forEach((item) => {
      const tr = document.createElement('tr');
      tr.id = `row-${item.id}`;
      tr.className = `queue-row status-${item.status}`;

      // Space Saved Calculation
      let savedHtml = '—';
      if (item.status === 'completed' && item.compressedSize !== null) {
        const diff = item.originalSize - item.compressedSize;
        const pct = Math.round((diff / item.originalSize) * 100);
        const isSmaller = diff > 0;
        savedHtml = `
          <span class="badge ${isSmaller ? 'badge-success' : 'badge-neutral'}">
            ${isSmaller ? `-${pct}%` : '0%'} (${formatBytes(Math.abs(diff))})
          </span>
        `;
      }

      // Status & Progress Bar
      let statusHtml = '';
      if (item.status === 'queued') {
        statusHtml = `<span class="status-pill status-queued">Queued</span>`;
      } else if (item.status === 'processing') {
        statusHtml = `
          <div class="progress-cell">
            <span class="phase-text">${item.phase} (${item.progress}%)</span>
            <div class="item-progress-track">
              <div class="item-progress-fill" style="width: ${item.progress}%"></div>
            </div>
          </div>
        `;
      } else if (item.status === 'completed') {
        statusHtml = `<span class="status-pill status-completed">✓ Completed</span>`;
      } else if (item.status === 'error') {
        statusHtml = `<span class="status-pill status-error" title="${item.error || 'Failed'}">⚠️ Error</span>`;
      }

      // Action Buttons
      let actionHtml = '';
      if (item.status === 'completed') {
        actionHtml = `
          <button class="btn btn-sm btn-primary" onclick="window.App.downloadItem('${item.id}')">💾 Save</button>
          ${item.typeInfo.category !== 'document' ? `
            <button class="btn btn-sm btn-secondary" onclick="window.App.openCompareModal('${item.id}')">🔍 Preview</button>
          ` : ''}
        `;
      } else if (item.status === 'queued') {
        actionHtml = `
          <button class="btn btn-sm btn-icon" onclick="window.App.removeItem('${item.id}')" title="Remove">✕</button>
        `;
      }

      tr.innerHTML = `
        <td class="col-name">
          <div class="file-name-wrapper">
            <span class="file-icon">${item.typeInfo.icon}</span>
            <span class="file-name-text" title="${item.name}">${item.name}</span>
          </div>
        </td>
        <td class="col-type"><span class="badge badge-type">${item.typeInfo.label}</span></td>
        <td class="col-size">${formatBytes(item.originalSize)}</td>
        <td class="col-comp-size">${item.compressedSize ? formatBytes(item.compressedSize) : '—'}</td>
        <td class="col-saved">${savedHtml}</td>
        <td class="col-status">${statusHtml}</td>
        <td class="col-actions">${actionHtml}</td>
      `;

      DOM.queueTableBody.appendChild(tr);
    });
  }

  // Update specific row without full table redraw
  function updateRow(item) {
    const tr = document.getElementById(`row-${item.id}`);
    if (!tr) return;

    tr.className = `queue-row status-${item.status}`;
    const compCell = tr.querySelector('.col-comp-size');
    const savedCell = tr.querySelector('.col-saved');
    const statusCell = tr.querySelector('.col-status');
    const actionCell = tr.querySelector('.col-actions');

    if (compCell && item.compressedSize !== null) {
      compCell.textContent = formatBytes(item.compressedSize);
    }

    if (savedCell && item.status === 'completed' && item.compressedSize !== null) {
      const diff = item.originalSize - item.compressedSize;
      const pct = Math.round((diff / item.originalSize) * 100);
      const isSmaller = diff > 0;
      savedCell.innerHTML = `
        <span class="badge ${isSmaller ? 'badge-success' : 'badge-neutral'}">
          ${isSmaller ? `-${pct}%` : '0%'} (${formatBytes(Math.abs(diff))})
        </span>
      `;
    }

    if (statusCell) {
      if (item.status === 'processing') {
        statusCell.innerHTML = `
          <div class="progress-cell">
            <span class="phase-text">${item.phase} (${item.progress}%)</span>
            <div class="item-progress-track">
              <div class="item-progress-fill" style="width: ${item.progress}%"></div>
            </div>
          </div>
        `;
      } else if (item.status === 'completed') {
        statusCell.innerHTML = `<span class="status-pill status-completed">✓ Completed</span>`;
      } else if (item.status === 'error') {
        statusCell.innerHTML = `<span class="status-pill status-error" title="${item.error || 'Failed'}">⚠️ Error</span>`;
      }
    }

    if (actionCell && item.status === 'completed') {
      actionCell.innerHTML = `
        <button class="btn btn-sm btn-primary" onclick="window.App.downloadItem('${item.id}')">💾 Save</button>
        ${item.typeInfo.category !== 'document' ? `
          <button class="btn btn-sm btn-secondary" onclick="window.App.openCompareModal('${item.id}')">🔍 Preview</button>
        ` : ''}
      `;
    }
  }

  // Update Global Progress and Batch Statistics
  function updateGlobalStats() {
    const total = state.queue.length;
    const completed = state.queue.filter((i) => i.status === 'completed').length;
    const processing = state.queue.filter((i) => i.status === 'processing').length;

    let origBytes = 0;
    let compBytes = 0;
    state.queue.forEach((i) => {
      origBytes += i.originalSize;
      if (i.compressedSize !== null) {
        compBytes += i.compressedSize;
      } else {
        compBytes += i.originalSize;
      }
    });

    const diff = origBytes - compBytes;
    const pct = origBytes > 0 ? Math.round((diff / origBytes) * 100) : 0;

    DOM.totalSavedBadge.textContent = diff > 0
      ? `Saved: ${formatBytes(diff)} (-${pct}%)`
      : 'Saved: 0 B';

    const globalPct = total > 0 ? Math.round((completed / total) * 100) : 0;
    DOM.globalProgressBar.style.width = `${globalPct}%`;
    DOM.globalStatusText.textContent = `${completed}/${total} files completed`;

    DOM.btnDownloadAll.disabled = completed === 0;
    DOM.btnStartBatch.disabled = state.isProcessing || total === 0 || completed === total;
  }

  // Item Processor Router
  async function processQueueItem(item) {
    item.status = 'processing';
    item.progress = 10;
    item.phase = 'Starting';
    updateRow(item);

    // Ensure all compression dependencies are loaded before executing
    if (window.DependencyLoader && window.DependencyLoader.ready) {
      await window.DependencyLoader.ready();
    }

    const options = getEffectiveOptions();

    try {
      if (item.typeInfo.category === 'image') {
        item.phase = 'Analyzing & Compressing';
        updateRow(item);

        const res = await window.ImageProcessor.compressImage(item.file, {
          sourceMime: item.file.type || `image/${item.typeInfo.ext}`,
          requestedFormat: options.imageOptions.requestedFormat,
          quality: options.imageOptions.quality,
          maxBoundingBox: options.imageOptions.maxBoundingBox,
          isEmbeddedDoc: false
        });

        // Determine extension
        let newExt = item.typeInfo.ext;
        if (res.mime === 'image/webp') newExt = 'webp';
        else if (res.mime === 'image/jpeg') newExt = 'jpg';
        else if (res.mime === 'image/png') newExt = 'png';

        item.finalName = item.name.replace(/\.[^.]+$/, `.${newExt}`);
        item.resultBlob = res.blob;
        item.compressedSize = res.buffer.byteLength;
        item.resultUrl = createManagedUrl(res.blob);
      } else if (item.typeInfo.category === 'video') {
        item.phase = 'Transcoding Video';
        updateRow(item);

        const videoOpts = { ...options.videoOptions, filename: item.name };
        const processor = window.MediaProcessor || window.VideoProcessor;
        const res = await processor.compressMedia(item.file, videoOpts, (prog) => {
          item.progress = prog.progress || 50;
          item.phase = `${prog.phase || 'Encoding'} (${item.progress}%)`;
          updateRow(item);
        });

        const newExt = res.container === 'mp4' ? 'mp4' : 'mkv';
        item.finalName = item.name.replace(/\.[^.]+$/, `.${newExt}`);
        item.resultBlob = res.blob || new Blob([res.buffer], { type: res.mime });
        item.compressedSize = res.buffer ? res.buffer.byteLength : res.blob.size;
        item.resultUrl = createManagedUrl(item.resultBlob);
      } else if (item.typeInfo.category === 'audio') {
        item.phase = 'Compressing Audio';
        updateRow(item);

        const audioOpts = {
          ...options.audioOptions,
          mode: 'audio-only',
          filename: item.name,
          mime: item.file.type
        };
        const processor = window.MediaProcessor || window.AudioProcessor;
        const res = await processor.compressMedia(item.file, audioOpts, (prog) => {
          item.progress = prog.progress || 50;
          item.phase = `${prog.phase || 'Encoding'} (${item.progress}%)`;
          updateRow(item);
        });

        const newExt = res.container === 'm4a' ? 'm4a' : (res.container || 'm4a');
        item.finalName = item.name.replace(/\.[^.]+$/, `.${newExt}`);
        item.resultBlob = res.blob || new Blob([res.buffer], { type: res.mime });
        item.compressedSize = res.buffer ? res.buffer.byteLength : res.blob.size;
        item.resultUrl = createManagedUrl(item.resultBlob);
      } else if (item.typeInfo.category === 'document') {
        item.phase = 'Processing Document Media';
        updateRow(item);

        const res = await window.DocProcessor.processDocument(item.file, options, (prog) => {
          item.progress = prog.progress || 50;
          item.phase = prog.phase || 'Compressing';
          updateRow(item);
        });

        let newExt = item.typeInfo.ext;
        if (res.convertedExtension) newExt = res.convertedExtension;
        item.finalName = item.name.replace(/\.[^.]+$/, `.${newExt}`);
        item.resultBlob = res.blob;
        item.compressedSize = res.buffer ? res.buffer.byteLength : res.blob.size;
        item.resultUrl = createManagedUrl(res.blob);
      }

      item.status = 'completed';
      item.progress = 100;
      item.phase = 'Completed';
    } catch (err) {
      console.error(`[Queue] Failed processing item ${item.name}:`, err);
      item.status = 'error';
      item.error = err.message || String(err);
      item.phase = 'Failed';
    } finally {
      updateRow(item);
      updateGlobalStats();
    }
  }

  // Concurrency Orchestrator:
  // Strictly runs video processing sequentially (max 1 active video encoding at any time).
  // Images and Documents run concurrently up to maxConcurrency.
  async function startBatch() {
    if (state.isProcessing) return;
    state.isProcessing = true;
    DOM.btnStartBatch.disabled = true;

    const queuedItems = state.queue.filter((i) => i.status === 'queued');
    const maxConcurrency = Math.max(2, navigator.hardwareConcurrency || 4);

    let activeCount = 0;
    let index = 0;

    return new Promise((resolve) => {
      function next() {
        while (activeCount < maxConcurrency && index < queuedItems.length) {
          const item = queuedItems[index++];
          activeCount++;

          processQueueItem(item).finally(() => {
            activeCount--;
            if (index < queuedItems.length) {
              next();
            } else if (activeCount === 0) {
              state.isProcessing = false;
              updateGlobalStats();
              resolve();
            }
          });
        }

        if (queuedItems.length === 0 || (index >= queuedItems.length && activeCount === 0)) {
          state.isProcessing = false;
          updateGlobalStats();
          resolve();
        }
      }

      next();
    });
  }

  // Download Individual Item
  function downloadItem(itemId) {
    const item = state.queue.find((i) => i.id === itemId);
    if (!item || !item.resultBlob) return;

    const a = document.createElement('a');
    a.href = item.resultUrl || URL.createObjectURL(item.resultBlob);
    a.download = item.finalName || `compressed_${item.name}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // Download All Items as a single ZIP Archive via JSZip
  async function downloadAllAsZip() {
    const completedItems = state.queue.filter((i) => i.status === 'completed' && i.resultBlob);
    if (completedItems.length === 0) return;

    DOM.btnDownloadAll.textContent = '⏳ Compressing ZIP...';
    DOM.btnDownloadAll.disabled = true;

    try {
      const JSZip = window.JSZip;
      if (!JSZip) throw new Error('JSZip not available');
      const zip = new JSZip();

      for (const item of completedItems) {
        zip.file(item.finalName || item.name, item.resultBlob);
      }

      const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      });

      const zipUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = zipUrl;
      a.download = `OfficeCompressor_Batch_${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(zipUrl), 60000);
    } catch (e) {
      alert(`Failed to create ZIP: ${e.message}`);
    } finally {
      DOM.btnDownloadAll.textContent = '📦 Download All (ZIP)';
      DOM.btnDownloadAll.disabled = false;
    }
  }

  // Remove Item from Queue
  function removeItem(itemId) {
    const idx = state.queue.findIndex((i) => i.id === itemId);
    if (idx !== -1) {
      const item = state.queue[idx];
      if (item.resultUrl) revokeManagedUrl(item.resultUrl);
      state.queue.splice(idx, 1);
      renderQueueTable();
      updateGlobalStats();
    }
  }

  // Clear Completed or All Items
  function clearQueue() {
    state.queue.forEach((item) => {
      if (item.resultUrl) revokeManagedUrl(item.resultUrl);
    });
    state.queue = [];
    renderQueueTable();
    updateGlobalStats();
  }

  // Visual Comparison Modal
  function openCompareModal(itemId) {
    const item = state.queue.find((i) => i.id === itemId);
    if (!item || !item.resultBlob) return;

    DOM.modalTitle.textContent = `Comparison: ${item.name}`;
    DOM.modalOriginalMeta.textContent = `Original: ${formatBytes(item.originalSize)}`;
    DOM.modalCompressedMeta.textContent = `Compressed: ${formatBytes(item.compressedSize)} (-${Math.round(((item.originalSize - item.compressedSize)/item.originalSize)*100)}%)`;

    DOM.modalOrigPreview.innerHTML = '';
    DOM.modalCompPreview.innerHTML = '';

    const origUrl = createManagedUrl(item.file);
    const compUrl = item.resultUrl || createManagedUrl(item.resultBlob);

    if (item.typeInfo.category === 'image') {
      DOM.modalOrigPreview.innerHTML = `<img src="${origUrl}" alt="Original" class="preview-media" />`;
      DOM.modalCompPreview.innerHTML = `<img src="${compUrl}" alt="Compressed" class="preview-media" />`;
    } else if (item.typeInfo.category === 'video') {
      DOM.modalOrigPreview.innerHTML = `<video src="${origUrl}" controls muted playsinline class="preview-media"></video>`;
      DOM.modalCompPreview.innerHTML = `<video src="${compUrl}" controls playsinline class="preview-media"></video>`;
    } else if (item.typeInfo.category === 'audio') {
      DOM.modalOrigPreview.innerHTML = `<audio src="${origUrl}" controls class="preview-media" style="width: 100%; margin-top: 1rem;"></audio>`;
      DOM.modalCompPreview.innerHTML = `<audio src="${compUrl}" controls class="preview-media" style="width: 100%; margin-top: 1rem;"></audio>`;
    }

    DOM.compareModal.classList.remove('hidden');
  }

  function closeCompareModal() {
    DOM.compareModal.classList.add('hidden');
    DOM.modalOrigPreview.innerHTML = '';
    DOM.modalCompPreview.innerHTML = '';
  }

  // Initialize Event Listeners
  function setupEventListeners() {
    // Theme toggle
    DOM.themeToggle.addEventListener('click', () => {
      applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    });

    // Preset cards
    DOM.presetCards.forEach((card) => {
      card.addEventListener('click', () => {
        selectPreset(card.dataset.preset);
      });
    });

    // Custom configuration accordion inputs auto-select custom preset
    if (DOM.customAccordion) {
      DOM.customAccordion.addEventListener('change', () => {
        selectPreset('custom');
      });
    }

    // Custom rate control toggle
    DOM.customRateControl.addEventListener('change', (e) => {
      const val = e.target.value;
      document.getElementById('group-quality-factor').classList.toggle('hidden', val !== 'qualityFactor');
      document.getElementById('group-exact-bitrate').classList.toggle('hidden', val !== 'bitrate');
      document.getElementById('group-target-size').classList.toggle('hidden', val !== 'targetSize');
    });

    // Custom image quality slider
    DOM.customImgQuality.addEventListener('input', (e) => {
      DOM.customImgQualityVal.textContent = `${e.target.value}%`;
    });

    // Prevent default window file dropping navigation
    window.addEventListener('dragenter', (e) => e.preventDefault());
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer && DOM.dropzone && !DOM.dropzone.contains(e.target)) {
        e.dataTransfer.dropEffect = 'none';
      }
    });
    window.addEventListener('drop', (e) => e.preventDefault());

    // Dropzone drag-and-drop
    DOM.dropzone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
      DOM.dropzone.classList.add('drag-over');
    });

    DOM.dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
      DOM.dropzone.classList.add('drag-over');
    });

    DOM.dropzone.addEventListener('dragleave', (e) => {
      if (!DOM.dropzone.contains(e.relatedTarget)) {
        DOM.dropzone.classList.remove('drag-over');
      }
    });

    DOM.dropzone.addEventListener('drop', handleDropEvent);

    DOM.dropzone.addEventListener('click', () => {
      DOM.fileInput.click();
    });

    DOM.fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        addToQueue(e.target.files);
        e.target.value = '';
      }
    });

    // Batch Actions
    DOM.btnStartBatch.addEventListener('click', startBatch);
    DOM.btnDownloadAll.addEventListener('click', downloadAllAsZip);
    DOM.btnClearQueue.addEventListener('click', clearQueue);

    // Modal
    DOM.modalClose.addEventListener('click', closeCompareModal);
    DOM.compareModal.addEventListener('click', (e) => {
      if (e.target === DOM.compareModal) closeCompareModal();
    });

    // Resilient Dependency Loader status listener
    if (window.DependencyLoader) {
      window.DependencyLoader.ready().then((info) => {
        const isAllLoaded = info.loaded === info.total;
        DOM.depStatusPill.className = `dep-pill ${isAllLoaded ? 'dep-ok' : 'dep-warn'}`;
        DOM.depStatusPill.textContent = `${info.loaded}/${info.total} Libs Ready`;
        DOM.depStatusPill.title = Object.entries(info.status)
          .map(([k, v]) => `${k}: ${v.loaded ? v.source : 'failed'}`)
          .join('\n');
      });
    }
  }

  // Application bootstrap
  async function init() {
    initDomReferences();
    applyTheme(state.theme);
    setupEventListeners();
    await detectCodecs();
    selectPreset('email-standard');
    console.log('[App] Office Compressor initialized.');
  }

  // Export public API to window for inline onclick handlers
  window.App = {
    init,
    downloadItem,
    removeItem,
    clearQueue,
    openCompareModal,
    closeCompareModal
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
