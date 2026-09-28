# Office Compressor - Production-Grade Client-Side Media & Document Optimizer

An enterprise-grade, 100% client-side static web application designed as a web-native, zero-install alternative to NXPowerLite Desktop, featuring embedded video and image compression inside Office files.

---

## Key Highlights

- **100% Client-Side Execution:** Zero server backend or external APIs. All processing runs in memory on modern desktop browsers (Chrome, Edge, Firefox).
- **Dual Execution Modes:**
  - **Local Web Server:** `http://localhost:3000/`
  - **Direct File Execution:** `file:///d:/Code/Office-Compressor/Office-Compressor/index.html` (Dynamic Blob URLs for Workers avoid CORS blocks).
- **Resilient Dependency Loader (`loader.js`):** Loads libraries from pre-downloaded local `./libs/*.js` with automatic failover to public CDNs (jsDelivr / cdnjs).
- **Hardware & Memory Protection:**
  - **Sequential Video Lock:** Strictly enforces max 1 active hardware encoder session at a time to prevent GPU `QuotaExceededError`.
  - **Parallel Image/Doc Processing:** Runs concurrent image and document tasks up to `navigator.hardwareConcurrency || 4`.
  - **Explicit Garbage Collection:** Actively revokes all Object URLs (`URL.revokeObjectURL`) and dereferences ArrayBuffers immediately after processing.

---

## File Architecture (`D:\Code\Office-Compressor\Office-Compressor`)

| File | Description |
|---|---|
| [`index.html`](file:///d:/Code/Office-Compressor/Office-Compressor/index.html) | Responsive UI markup, dropzone, presets, batch table, and comparison modal |
| [`styles.css`](file:///d:/Code/Office-Compressor/Office-Compressor/styles.css) | Modern enterprise design system (Dark & Light neutral themes, glassmorphism, micro-animations) |
| [`loader.js`](file:///d:/Code/Office-Compressor/Office-Compressor/loader.js) | Resilient dependency manager with local `./libs/*.js` priority and CDN fallbacks |
| [`app.js`](file:///d:/Code/Office-Compressor/Office-Compressor/app.js) | Main UI controller, preset mapping, dynamic codec detection (`VideoEncoder.isConfigSupported()`), and batch queue |
| [`doc-processor.js`](file:///d:/Code/Office-Compressor/Office-Compressor/doc-processor.js) | Office ZIP (`JSZip`), legacy XLS (`SheetJS`), legacy OLE2 (`CFB`), and PDF (`pdf-lib`) media replacement engine |
| [`image-worker.js`](file:///d:/Code/Office-Compressor/Office-Compressor/image-worker.js) | Image pipeline supporting native formats, TIFF (`UTIF.js`), Auto screenshot vs photo heuristic, and OffscreenCanvas |
| [`video-worker.js`](file:///d:/Code/Office-Compressor/Office-Compressor/video-worker.js) | WebCodecs demuxer/encoder pipeline (MP4, MKV/WebM, AVI H.264, MTS/M2TS Blu-ray AVCHD), liba52 AC-3 audio demux/decode to AAC, dynamic bitrate formulas, and MP4/MKV muxing |
| [`libs/`](file:///d:/Code/Office-Compressor/Office-Compressor/libs) | Bundled third-party libraries for offline operation (`jszip`, `xlsx`, `cfb`, `pdf-lib`, `utif`, `mp4box`, `mp4-muxer`, `webm-muxer`, `decode-ac3`) |
| [`server.js`](file:///d:/Code/Office-Compressor/Office-Compressor/server.js) | Lightweight static development server for local testing |

---

## Compression Pipelines & Rules

### 1. Document Parsing & Packaging Engine
- **Modern Office (`.docx`, `.pptx`, `.xlsx`):** Rebuilds ZIP structures via `JSZip`.
  - **Embedded Images:** Re-encoded **ONLY as JPEG (`image/jpeg`) or PNG (`image/png`)**. WebP is strictly forbidden inside documents for backward compatibility with older Office versions.
  - **Embedded Videos:** In `.pptx` or `.docx` (`ppt/media/*`, `word/media/*`), embedded videos are **always and only** re-encoded as **AVC (H.264) + AAC in an MP4 container**.
- **Legacy Excel (`.xls`):** Parses BIFF8 and re-exports directly to modern, compressed `.xlsx` via `SheetJS`.
- **Legacy Word/PowerPoint (`.doc`, `.ppt`):** Parses binary OLE2 streams via `CFB`, scans BLIP picture records (`Pictures`, `Data`), downsamples image bytes in-place, and updates the container.
- **PDF (`.pdf`):** Enumerates indirect objects via `pdf-lib`, downsamples embedded image `XObject` streams (`DCTDecode` / `FlateDecode`), and rewrites stream dictionaries.

### 2. Standalone & Embedded Image Pipeline
- **Input Formats:** JPEG, PNG, WEBP, AVIF, GIF, BMP via `createImageBitmap({ imageOrientation: 'from-image' })` (EXIF orientation respected), plus TIFF via `UTIF.js`.
- **Auto Format Selection Heuristic:**
  1. *Lossy Source Check:* If source is already lossy (JPEG, lossy WebP), treat strictly as photography—never convert back to PNG or lossless WebP.
  2. *Lossless / Uncompressed Source Check (PNG, BMP, TIFF, GIF):* Samples a $100 \times 100$ pixel grid:
     - Low unique color variance / flat solid runs (UI screenshots, charts) $\rightarrow$ PNG or Lossless WebP.
     - High color variance / gradients / photo noise $\rightarrow$ Lossy WebP or JPEG.

### 3. Video Pipeline (WebCodecs)
- **Demuxing:**
  - `MP4Box.js` for MP4/MOV.
  - RIFF parser for AVI (H.264 stream).
  - Pure-JS BDAV / MPEG-TS demuxer for standalone **MTS / M2TS Blu-ray videos** (from Sony HDR camcorders): handles 192-byte and 188-byte packets, PAT/PMT extraction, PES video reassembly, SPS aspect ratio / profile parsing, dynamic `avcC` configuration, AC-3 audio PES reassembly, and deinterlaced scaling to email-friendly MP4.
  - **AC-3 Audio Transcoding Engine (`liba52` WASM):** Decodes raw Dolby Digital AC-3 stream (`PID 0x1100`, ATSC A/52) via embedded `liba52` WebAssembly, downmixes multi-channel/5.1 surround to high-fidelity stereo Float32Array PCM, and encodes into AAC (`mp4a.40.2`) via WebCodecs `AudioEncoder` with accurate PTS offset synchronization.
  - EBML parser for MKV/WebM, and universal HTML5 `<video>` extraction fallback.
- **Dynamic Bitrate Formula:**
  $$\text{bitrate (bps)} = \text{Math.round}(\text{width} \times \text{height} \times \text{fps} \times \text{qualityFactor})$$
  - `'low'`: `0.05` (Email Strict)
  - `'good'`: `0.08` (Email Standard)
  - `'high'`: `0.10` (Screen Presentation)
  - `'very-high'`: `0.15` (Archival)
- **Alternative Target Size Mode:**
  $$\text{bitrate} = \frac{(\text{targetBytes} \times 8) - (\text{audioBitrate} \times \text{duration})}{\text{duration}}$$
- **Codec & Muxing:** Dynamic `VideoEncoder.isConfigSupported()` selection (AVC, HEVC, VP9, AV1), framerate downsampling, audio transcode/pass-through/mute, and muxing via `Mp4Muxer` / `WebMMuxer`.

---

## Presets Summary

| Preset | Target Size | Video Settings | Image / Doc Settings |
|---|---|---|---|
| **Email Strict** | < 10 MB | 480p @ 15fps, Low Bitrate (0.05), AAC 64 kbps | 720p max bounding box, Q: 60 |
| **Email Standard** | < 25 MB | 720p @ 15fps, Good Bitrate (0.08), AAC 96 kbps | 1080p max bounding box, Q: 75 |
| **Screen Presentation** | High Fidelity | 1080p @ original fps, High Bitrate (0.10), Audio Pass-through | 1080p max bounding box, Q: 85 (PNG for charts), strip metadata |
| **Custom Mode** | User-defined | Configurable resolution, fps, rate control, codec, container, audio | Configurable format, quality slider (1-100), bounding box |
