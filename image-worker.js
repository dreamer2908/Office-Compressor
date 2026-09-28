/**
 * image-worker.js - High-Performance Image Compression Pipeline
 * 
 * Functions both as an Inlined Web Worker and as a fallback in-thread image processor.
 * Supports native decoding (JPEG, PNG, WEBP, AVIF, GIF, BMP) via createImageBitmap with EXIF orientation,
 * plus TIFF decoding via UTIF.js.
 * Implements intelligent screenshot vs photo heuristic for Auto mode, OffscreenCanvas resizing,
 * and strict Office compliance (JPEG/PNG only for embedded document images).
 */

(function (globalScope) {
  'use strict';

  /**
   * Calculates aspect-ratio preserving dimensions respecting orientation.
   */
  function calculateDimensions(origW, origH, maxW, maxH) {
    if (!maxW && !maxH) return { width: origW, height: origH, scale: 1.0 };
    maxW = maxW || origW;
    maxH = maxH || origH;

    const isPortrait = origH > origW;
    const boxW = isPortrait ? Math.min(maxW, maxH) : Math.max(maxW, maxH);
    const boxH = isPortrait ? Math.max(maxW, maxH) : Math.min(maxW, maxH);

    // Never upscale
    const ratio = Math.min(boxW / origW, boxH / origH, 1.0);
    return {
      width: Math.max(1, Math.round(origW * ratio)),
      height: Math.max(1, Math.round(origH * ratio)),
      scale: ratio
    };
  }

  /**
   * Samples a 100x100 pixel grid to classify content as UI Screenshot/Chart vs Photography.
   */
  function analyzeImageContent(ctx, width, height) {
    const sampleW = Math.min(width, 100);
    const sampleH = Math.min(height, 100);
    const imgData = ctx.getImageData(0, 0, sampleW, sampleH);
    const data = imgData.data;
    const totalPixels = sampleW * sampleH;

    const colorMap = new Set();
    let flatTransitions = 0;
    let prevR = -1, prevG = -1, prevB = -1;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      // Quantize to 5 bits per channel (32 levels) to handle slight gradient banding
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      colorMap.add(key);

      if (prevR !== -1) {
        const diff = Math.abs(r - prevR) + Math.abs(g - prevG) + Math.abs(b - prevB);
        if (diff < 8) flatTransitions++;
      }
      prevR = r;
      prevG = g;
      prevB = b;
    }

    const uniqueColorRatio = colorMap.size / totalPixels;
    const flatRunRatio = flatTransitions / totalPixels;
    const isScreenshot = uniqueColorRatio < 0.14 || flatRunRatio > 0.40;

    return {
      isScreenshot,
      uniqueColorRatio,
      flatRunRatio
    };
  }

  /**
   * Determine target format based on source, settings, and embedded constraints.
   */
  function determineOutputFormat(sourceMime, requestedFormat, isEmbeddedDoc, analysis) {
    // Embedded images MUST strictly be JPEG or PNG for Office backward compatibility
    if (isEmbeddedDoc) {
      if (sourceMime === 'image/png' || sourceMime.includes('png')) {
        return analysis && !analysis.isScreenshot ? 'image/jpeg' : 'image/png';
      }
      return 'image/jpeg';
    }

    if (requestedFormat && requestedFormat !== 'auto') {
      if (requestedFormat === 'webp') return 'image/webp';
      if (requestedFormat === 'jpeg' || requestedFormat === 'jpg') return 'image/jpeg';
      if (requestedFormat === 'png') return 'image/png';
    }

    // Auto Mode Heuristic:
    // 1. Lossy Source Check: If already lossy (JPEG or lossy WebP), NEVER convert back to PNG/lossless
    const isSourceLossy = sourceMime === 'image/jpeg' || sourceMime === 'image/jpg' || sourceMime === 'image/webp';
    if (isSourceLossy) {
      return 'image/webp'; // WebP achieves best compression for photography
    }

    // 2. Lossless/Uncompressed Source (PNG, BMP, TIFF, GIF)
    if (analysis && analysis.isScreenshot) {
      return 'image/png'; // Crisp screenshots, solid runs
    }
    return 'image/webp'; // Natural photo content
  }

  /**
   * Core image compression function.
   * Can accept a Blob or ArrayBuffer.
   */
  async function compressImage(inputData, options = {}) {
    const {
      sourceMime = 'image/jpeg',
      requestedFormat = 'auto',
      quality = 75,
      maxBoundingBox = null, // e.g. { width: 1920, height: 1080 }
      isEmbeddedDoc = false,
      utifLib = null // UTIF reference if passed
    } = options;

    let bitmap = null;
    let origWidth = 0;
    let origHeight = 0;

    // Check if format is TIFF
    const isTiff = sourceMime.includes('tiff') || sourceMime.includes('tif');
    const UTIF = utifLib || (typeof globalScope !== 'undefined' ? globalScope.UTIF : null);

    if (isTiff && UTIF) {
      const buffer = inputData instanceof ArrayBuffer ? inputData : await inputData.arrayBuffer();
      const ifds = UTIF.decode(buffer);
      UTIF.decodeImage(buffer, ifds[0]);
      const rgba = UTIF.toRGBA8(ifds[0]);
      origWidth = ifds[0].width;
      origHeight = ifds[0].height;

      const imgData = new ImageData(new Uint8ClampedArray(rgba), origWidth, origHeight);
      const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(origWidth, origHeight)
        : document.createElement('canvas');
      canvas.width = origWidth;
      canvas.height = origHeight;
      const ctx = canvas.getContext('2d');
      ctx.putImageData(imgData, 0, 0);

      bitmap = canvas;
    } else {
      const blob = inputData instanceof Blob ? inputData : new Blob([inputData], { type: sourceMime });
      bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      origWidth = bitmap.width;
      origHeight = bitmap.height;
    }

    // Calculate dimensions
    const maxW = maxBoundingBox ? maxBoundingBox.width : null;
    const maxH = maxBoundingBox ? maxBoundingBox.height : null;
    const targetDim = calculateDimensions(origWidth, origHeight, maxW, maxH);

    // Create OffscreenCanvas for rendering
    let canvas;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(targetDim.width, targetDim.height);
    } else {
      canvas = document.createElement('canvas');
      canvas.width = targetDim.width;
      canvas.height = targetDim.height;
    }

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, targetDim.width, targetDim.height);

    // Free bitmap memory
    if (bitmap.close) bitmap.close();

    // Analyze content for Auto mode
    const analysis = analyzeImageContent(ctx, targetDim.width, targetDim.height);
    const targetMime = determineOutputFormat(sourceMime, requestedFormat, isEmbeddedDoc, analysis);

    // Normalize quality to [0.01, 1.0]
    const normQuality = Math.max(0.01, Math.min(1.0, quality / 100));

    let outputBlob;
    if (canvas.convertToBlob) {
      outputBlob = await canvas.convertToBlob({
        type: targetMime,
        quality: normQuality
      });
    } else {
      outputBlob = await new Promise((resolve) => {
        canvas.toBlob((b) => resolve(b), targetMime, normQuality);
      });
    }

    const outputBuffer = await outputBlob.arrayBuffer();

    return {
      buffer: outputBuffer,
      blob: outputBlob,
      mime: targetMime,
      width: targetDim.width,
      height: targetDim.height,
      origWidth,
      origHeight,
      analysis,
      quality: normQuality
    };
  }

  // Handle Web Worker messages
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && !self.document) {
    self.onmessage = async function (e) {
      const { id, data, options } = e.data;
      try {
        const result = await compressImage(data, options);
        // Transfer ArrayBuffer for zero-copy performance
        self.postMessage({
          id,
          success: true,
          result: {
            buffer: result.buffer,
            mime: result.mime,
            width: result.width,
            height: result.height,
            origWidth: result.origWidth,
            origHeight: result.origHeight,
            analysis: result.analysis
          }
        }, [result.buffer]);
      } catch (err) {
        self.postMessage({
          id,
          success: false,
          error: err.message || String(err)
        });
      }
    };
  }

  // Export for main thread usage
  const ImageProcessor = {
    compressImage,
    calculateDimensions,
    analyzeImageContent,
    determineOutputFormat
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ImageProcessor;
  } else {
    globalScope.ImageProcessor = ImageProcessor;
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this)));
