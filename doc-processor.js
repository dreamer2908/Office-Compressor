/**
 * doc-processor.js - Document Parsing & Packaging Engine
 * 
 * Compresses embedded media inside Modern Office documents (.docx, .pptx, .xlsx) via JSZip.
 * Re-exports Legacy Excel (.xls) to modern .xlsx via SheetJS.
 * Downsamples embedded BLIP picture streams in Legacy Word/PowerPoint (.doc, .ppt) via CFB.
 * Downsamples embedded image XObjects in PDF (.pdf) via pdf-lib.
 * 
 * Strictly follows embedded media rules:
 * - Embedded Images: JPEG or PNG ONLY (WebP strictly forbidden inside documents).
 * - Embedded Videos: AVC (H.264) + AAC in MP4 container ONLY.
 */

(function (globalScope) {
  'use strict';

  const IMAGE_EXT_REGEX = /\.(jpe?g|png|bmp|tiff?|gif)$/i;
  const VIDEO_EXT_REGEX = /\.(mp4|avi|mov|wmv|mkv|webm)$/i;

  /**
   * Process Modern Office formats (.docx, .pptx, .xlsx)
   */
  async function processModernOffice(arrayBuffer, options = {}, onProgress = null) {
    const JSZip = globalScope.JSZip || window.JSZip;
    if (!JSZip) throw new Error('JSZip library is not available');

    const zip = await JSZip.loadAsync(arrayBuffer);
    const mediaEntries = [];

    // Locate all media files in word/media, ppt/media, xl/media
    zip.forEach((relativePath, file) => {
      if (!file.dir && relativePath.match(/^(word|ppt|xl)\/media\//i)) {
        if (relativePath.match(IMAGE_EXT_REGEX)) {
          mediaEntries.push({ path: relativePath, type: 'image', file });
        } else if (relativePath.match(VIDEO_EXT_REGEX)) {
          mediaEntries.push({ path: relativePath, type: 'video', file });
        }
      }
    });

    const totalMedia = mediaEntries.length;
    console.log(`[DocProcessor] Found ${totalMedia} embedded media items in document.`);

    let processedCount = 0;

    for (const item of mediaEntries) {
      const origBuffer = await item.file.async('arraybuffer');
      const ext = item.path.split('.').pop().toLowerCase();

      if (item.type === 'image') {
        const mime = ext === 'png' ? 'image/png'
          : (ext === 'bmp' ? 'image/bmp'
          : (ext.startsWith('tif') ? 'image/tiff'
          : (ext === 'gif' ? 'image/gif' : 'image/jpeg')));

        try {
          // Recompress image with STRICT embedded rules: JPEG or PNG only!
          const result = await globalScope.ImageProcessor.compressImage(origBuffer, {
            ...options.imageOptions,
            sourceMime: mime,
            isEmbeddedDoc: true,
            maxBoundingBox: options.imageOptions?.maxBoundingBox || { width: 1920, height: 1080 },
            quality: options.imageOptions?.quality || 75
          });

          // Only replace if compressed is smaller than original
          if (result.buffer && result.buffer.byteLength < origBuffer.byteLength) {
            zip.file(item.path, result.buffer);
            console.log(`[DocProcessor] Compressed embedded image ${item.path}: ${origBuffer.byteLength} -> ${result.buffer.byteLength} bytes`);
          }
        } catch (e) {
          console.warn(`[DocProcessor] Skipping uncompressible image ${item.path}:`, e);
        }
      } else if (item.type === 'video') {
        try {
          // Recompress video with STRICT embedded rules: AVC + AAC MP4 only!
          const result = await globalScope.VideoProcessor.compressVideo(origBuffer, {
            ...options.videoOptions,
            container: 'mp4',
            codec: 'avc1.4D401F',
            audioMode: 'aac',
            isEmbeddedDoc: true
          }, (videoProg) => {
            if (onProgress && totalMedia > 0) {
              const basePct = (processedCount / totalMedia) * 80;
              const subPct = ((videoProg.progress || 0) / 100) * (80 / totalMedia);
              onProgress({
                phase: `Compressing video ${item.path}`,
                progress: Math.min(85, Math.round(basePct + subPct))
              });
            }
          });

          if (result.buffer && result.buffer.byteLength < origBuffer.byteLength) {
            zip.file(item.path, result.buffer);
            console.log(`[DocProcessor] Compressed embedded video ${item.path}: ${origBuffer.byteLength} -> ${result.buffer.byteLength} bytes`);
          }
        } catch (e) {
          console.warn(`[DocProcessor] Skipping uncompressible video ${item.path}:`, e);
        }
      }

      processedCount++;
      if (onProgress) {
        onProgress({
          phase: 'processing_media',
          progress: Math.round((processedCount / Math.max(1, totalMedia)) * 80),
          processedCount,
          totalMedia
        });
      }
    }

    // Strip unused thumbnail/preview if requested
    if (options.stripMetadata) {
      zip.remove('docProps/thumbnail.jpeg');
      zip.remove('docProps/thumbnail.wmf');
    }

    // Rebuild zip archive with maximum DEFLATE compression
    const outBlob = await zip.generateAsync(
      {
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 }
      },
      (metadata) => {
        if (onProgress) {
          onProgress({
            phase: 'packaging',
            progress: 80 + Math.round((metadata.percent / 100) * 20)
          });
        }
      }
    );

    return {
      blob: outBlob,
      buffer: await outBlob.arrayBuffer(),
      mime: 'application/vnd.openxmlformats-officedocument',
      mediaCount: totalMedia
    };
  }

  /**
   * Process Legacy Excel (.xls): converts BIFF8 directly to modern .xlsx
   */
  async function processLegacyExcel(arrayBuffer, options = {}, onProgress = null) {
    const XLSX = globalScope.XLSX || window.XLSX;
    if (!XLSX) throw new Error('SheetJS (XLSX) library is not available');

    if (onProgress) onProgress({ phase: 'parsing_xls', progress: 30 });
    const wb = XLSX.read(arrayBuffer, { type: 'array' });

    if (onProgress) onProgress({ phase: 'exporting_xlsx', progress: 70 });
    const xlsxArray = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
    const outBlob = new Blob([xlsxArray], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });

    if (onProgress) onProgress({ phase: 'completed', progress: 100 });

    return {
      blob: outBlob,
      buffer: xlsxArray.buffer || xlsxArray,
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      convertedExtension: 'xlsx'
    };
  }

  /**
   * Process Legacy Word / PowerPoint (.doc, .ppt) via CFB
   */
  async function processLegacyCompound(arrayBuffer, options = {}, onProgress = null) {
    const CFB = globalScope.CFB || window.CFB;
    if (!CFB) throw new Error('CFB library is not available');

    if (onProgress) onProgress({ phase: 'parsing_cfb', progress: 20 });
    const cfb = CFB.read(arrayBuffer, { type: 'array' });

    // Look for Pictures or Data streams
    let picturesEntry = null;
    for (const name of cfb.FileIndex) {
      if (name.name === 'Pictures' || name.name === 'Data') {
        picturesEntry = name;
        break;
      }
    }

    if (picturesEntry && picturesEntry.content && picturesEntry.content.length > 512) {
      if (onProgress) onProgress({ phase: 'optimizing_pictures', progress: 50 });
      const streamContent = new Uint8Array(picturesEntry.content);
      // Scan for JPEG headers (FF D8 FF) and PNG headers (89 50 4E 47)
      let offset = 0;
      let replaced = 0;

      while (offset < streamContent.length - 8) {
        // Detect JPEG
        if (streamContent[offset] === 0xFF && streamContent[offset+1] === 0xD8 && streamContent[offset+2] === 0xFF) {
          // Find end of JPEG (FF D9)
          let end = offset + 3;
          while (end < streamContent.length - 1) {
            if (streamContent[end] === 0xFF && streamContent[end+1] === 0xD9) {
              end += 2;
              break;
            }
            end++;
          }
          const jpegLen = end - offset;
          if (jpegLen > 1024 && jpegLen < streamContent.length - offset) {
            try {
              const jpegSlice = streamContent.slice(offset, end);
              const compressed = await globalScope.ImageProcessor.compressImage(jpegSlice, {
                sourceMime: 'image/jpeg',
                isEmbeddedDoc: true,
                maxBoundingBox: options.imageOptions?.maxBoundingBox || { width: 1280, height: 720 },
                quality: options.imageOptions?.quality || 75
              });
              if (compressed.buffer && compressed.buffer.byteLength < jpegLen) {
                const compU8 = new Uint8Array(compressed.buffer);
                // Zero-fill padding
                streamContent.set(compU8, offset);
                streamContent.fill(0, offset + compU8.length, end);
                replaced++;
              }
            } catch (e) {
              // skip
            }
          }
          offset = end;
          continue;
        }
        offset++;
      }

      if (replaced > 0) {
        picturesEntry.content = streamContent;
      }
    }

    if (onProgress) onProgress({ phase: 'rebuilding_cfb', progress: 85 });
    const outBin = CFB.write(cfb, { type: 'binary' });

    // Convert binary string/array to Uint8Array
    let outU8;
    if (typeof outBin === 'string') {
      outU8 = new Uint8Array(outBin.length);
      for (let i = 0; i < outBin.length; i++) {
        outU8[i] = outBin.charCodeAt(i) & 0xFF;
      }
    } else {
      outU8 = new Uint8Array(outBin);
    }

    const outBlob = new Blob([outU8], { type: 'application/x-ole-storage' });
    if (onProgress) onProgress({ phase: 'completed', progress: 100 });

    return {
      blob: outBlob,
      buffer: outU8.buffer,
      mime: 'application/x-ole-storage'
    };
  }

  /**
   * Process PDF documents (.pdf) via pdf-lib:
   * Enumerates indirect objects, detects image XObjects (DCTDecode / FlateDecode),
   * downsamples and recompresses to optimized JPEG streams.
   */
  async function processPdf(arrayBuffer, options = {}, onProgress = null) {
    const PDFLib = globalScope.PDFLib || window.PDFLib;
    if (!PDFLib) throw new Error('PDFLib library is not available');

    if (onProgress) onProgress({ phase: 'loading_pdf', progress: 15 });
    const pdfDoc = await PDFLib.PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
    const context = pdfDoc.context;
    const indirectObjects = context.enumerateIndirectObjects();

    let imageStreams = [];
    for (const [ref, obj] of indirectObjects) {
      if (obj instanceof PDFLib.PDFStream && obj.dict) {
        const subtype = obj.dict.get(PDFLib.PDFName.of('Subtype'));
        if (subtype === PDFLib.PDFName.of('Image')) {
          imageStreams.push({ ref, stream: obj });
        }
      }
    }

    const totalImages = imageStreams.length;
    console.log(`[DocProcessor] Found ${totalImages} image XObjects in PDF.`);

    let processedCount = 0;
    const maxBox = options.imageOptions?.maxBoundingBox || { width: 1280, height: 720 };
    const quality = options.imageOptions?.quality || 75;

    for (const item of imageStreams) {
      const { stream } = item;
      const dict = stream.dict;
      const filter = dict.get(PDFLib.PDFName.of('Filter'));
      const origContents = stream.getContents ? stream.getContents() : stream.contents;

      if (!origContents || origContents.length < 512) {
        processedCount++;
        continue;
      }

      const isJpeg = filter === PDFLib.PDFName.of('DCTDecode');
      const isFlate = filter === PDFLib.PDFName.of('FlateDecode');

      if (isJpeg || isFlate) {
        try {
          const blob = new Blob([origContents], { type: isJpeg ? 'image/jpeg' : 'image/png' });
          const compressed = await globalScope.ImageProcessor.compressImage(blob, {
            sourceMime: isJpeg ? 'image/jpeg' : 'image/png',
            requestedFormat: 'jpeg',
            maxBoundingBox: maxBox,
            quality: quality,
            isEmbeddedDoc: true
          });

          if (compressed.buffer && compressed.buffer.byteLength < origContents.length) {
            const compBytes = new Uint8Array(compressed.buffer);
            // Update PDFStream
            stream.contents = compBytes;
            dict.set(PDFLib.PDFName.of('Filter'), PDFLib.PDFName.of('DCTDecode'));
            dict.set(PDFLib.PDFName.of('Width'), PDFLib.PDFNumber.of(compressed.width));
            dict.set(PDFLib.PDFName.of('Height'), PDFLib.PDFNumber.of(compressed.height));
            dict.set(PDFLib.PDFName.of('ColorSpace'), PDFLib.PDFName.of('DeviceRGB'));
            dict.set(PDFLib.PDFName.of('BitsPerComponent'), PDFLib.PDFNumber.of(8));
            dict.set(PDFLib.PDFName.of('Length'), PDFLib.PDFNumber.of(compBytes.length));
            dict.delete(PDFLib.PDFName.of('DecodeParms'));
            console.log(`[DocProcessor] Downsampled PDF Image: ${origContents.length} -> ${compBytes.length} bytes`);
          }
        } catch (e) {
          // If individual image decode fails, continue safely
        }
      }

      processedCount++;
      if (onProgress && totalImages > 0) {
        onProgress({
          phase: 'downsampling_pdf_images',
          progress: 15 + Math.round((processedCount / totalImages) * 65),
          processedCount,
          totalImages
        });
      }
    }

    if (onProgress) onProgress({ phase: 'saving_pdf', progress: 85 });
    const pdfBytes = await pdfDoc.save({ useObjectStreams: true });
    const outBlob = new Blob([pdfBytes], { type: 'application/pdf' });

    if (onProgress) onProgress({ phase: 'completed', progress: 100 });

    return {
      blob: outBlob,
      buffer: pdfBytes.buffer || pdfBytes,
      mime: 'application/pdf',
      imagesProcessed: totalImages
    };
  }

  /**
   * Main Document Processor Router
   */
  async function processDocument(file, options = {}, onProgress = null) {
    const ext = file.name.split('.').pop().toLowerCase();
    const arrayBuffer = file instanceof ArrayBuffer ? file : await file.arrayBuffer();

    if (ext === 'docx' || ext === 'pptx' || ext === 'xlsx') {
      return processModernOffice(arrayBuffer, options, onProgress);
    } else if (ext === 'xls') {
      return processLegacyExcel(arrayBuffer, options, onProgress);
    } else if (ext === 'doc' || ext === 'ppt') {
      return processLegacyCompound(arrayBuffer, options, onProgress);
    } else if (ext === 'pdf') {
      return processPdf(arrayBuffer, options, onProgress);
    } else {
      throw new Error(`Unsupported document extension .${ext}`);
    }
  }

  const DocProcessor = {
    processDocument,
    processModernOffice,
    processLegacyExcel,
    processLegacyCompound,
    processPdf
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = DocProcessor;
  } else {
    globalScope.DocProcessor = DocProcessor;
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this)));
