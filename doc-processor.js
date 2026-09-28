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
    const XLSX = globalScope.XLSX || (typeof window !== 'undefined' ? window.XLSX : null);
    if (!XLSX) throw new Error('SheetJS (XLSX) library is not available');

    if (onProgress) onProgress({ phase: 'parsing_xls', progress: 30 });
    const inputU8 = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    const wb = XLSX.read(inputU8, { type: 'array' });

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
    const CFB = globalScope.CFB || (typeof window !== 'undefined' ? (window.CFB || (window.XLSX && window.XLSX.CFB)) : null);
    if (!CFB) throw new Error('CFB library is not available');

    if (onProgress) onProgress({ phase: 'parsing_cfb', progress: 15 });
    const inputU8 = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    const cfb = CFB.read(inputU8, { type: 'array' });

    // Locate Pictures and PowerPoint Document streams
    let picturesEntry = null;
    let pptDocEntry = null;
    for (const entry of cfb.FileIndex) {
      if (entry.name === 'Pictures') picturesEntry = entry;
      else if (entry.name === 'PowerPoint Document') pptDocEntry = entry;
      else if (entry.name === 'Data' && !picturesEntry) picturesEntry = entry;
    }

    if (picturesEntry && picturesEntry.content && picturesEntry.content.length > 512) {
      if (onProgress) onProgress({ phase: 'optimizing_pictures', progress: 30 });
      try {
        const ImageProcessor = globalScope.ImageProcessor || (typeof window !== 'undefined' ? window.ImageProcessor : null);
        const sc = new Uint8Array(picturesEntry.content);
        const pd = pptDocEntry && pptDocEntry.content ? new Uint8Array(pptDocEntry.content) : null;

        // Find BStoreEntry records (0xF007, payload length 36) in PowerPoint Document
        const bstoreEntries = [];
        if (pd) {
          let pDoc = 0;
          while (pDoc < pd.length - 8) {
            const type = pd[pDoc + 2] | (pd[pDoc + 3] << 8);
            const len = (pd[pDoc + 4] | (pd[pDoc + 5] << 8) | (pd[pDoc + 6] << 16) | (pd[pDoc + 7] << 24)) >>> 0;
            if (type === 0xF007 && len === 36) {
              const size = (pd[pDoc + 8 + 20] | (pd[pDoc + 8 + 21] << 8) | (pd[pDoc + 8 + 22] << 16) | (pd[pDoc + 8 + 23] << 24)) >>> 0;
              const delay = (pd[pDoc + 8 + 28] | (pd[pDoc + 8 + 29] << 8) | (pd[pDoc + 8 + 30] << 16) | (pd[pDoc + 8 + 31] << 24)) >>> 0;
              bstoreEntries.push({
                sizeOffset: pDoc + 8 + 20,
                delayOffset: pDoc + 8 + 28,
                size,
                delay
              });
              pDoc += 44;
            } else {
              pDoc++;
            }
          }
        }

        // Determine list of BLIPs to process
        let blipList = [];
        if (bstoreEntries.length > 0) {
          // Exactly matching PowerPoint's Drawing Group table
          blipList = bstoreEntries.map((b) => ({
            offset: b.delay,
            size: b.size,
            bstore: b
          }));
        } else {
          // Fallback: parse raw record headers directly from Pictures stream
          let p = 0;
          while (p < sc.length - 8) {
            const type = sc[p + 2] | (sc[p + 3] << 8);
            const len = (sc[p + 4] | (sc[p + 5] << 8) | (sc[p + 6] << 16) | (sc[p + 7] << 24)) >>> 0;
            if (type >= 0xF018 && type <= 0xF02A && len > 0 && p + 8 + len <= sc.length) {
              blipList.push({ offset: p, size: len + 8, bstore: null });
              p += 8 + len;
            } else {
              p++;
            }
          }
        }

        if (ImageProcessor && blipList.length > 0) {
          const newChunks = [];
          let currentNewOffset = 0;
          let anyCompressed = false;
          const totalBlips = blipList.length;

          for (let i = 0; i < totalBlips; i++) {
            const blip = blipList[i];
            const oldOffset = blip.offset;
            const oldSize = blip.size;

            if (oldOffset + oldSize > sc.length) {
              const rem = sc.slice(oldOffset);
              newChunks.push(rem);
              currentNewOffset += rem.length;
              break;
            }

            const recType = sc[oldOffset + 2] | (sc[oldOffset + 3] << 8);
            const isJpeg = (recType === 0xF01D);
            const isPng = (recType === 0xF01E);

            let compressedChunk = null;

            if (isJpeg || isPng) {
              // Locate raw image bytes starting marker
              let imgStart = -1;
              const searchLimit = Math.min(oldOffset + 60, oldOffset + oldSize);
              if (isJpeg) {
                for (let k = oldOffset + 8; k < searchLimit - 1; k++) {
                  if (sc[k] === 0xFF && sc[k + 1] === 0xD8) {
                    imgStart = k;
                    break;
                  }
                }
              } else if (isPng) {
                for (let k = oldOffset + 8; k < searchLimit - 3; k++) {
                  if (sc[k] === 0x89 && sc[k + 1] === 0x50 && sc[k + 2] === 0x4E && sc[k + 3] === 0x47) {
                    imgStart = k;
                    break;
                  }
                }
              }

              if (imgStart !== -1 && oldSize > 1024) {
                const headerPrefix = sc.slice(oldOffset, imgStart);
                const rawImageBytes = sc.slice(imgStart, oldOffset + oldSize);

                try {
                  const compResult = await ImageProcessor.compressImage(rawImageBytes, {
                    sourceMime: isJpeg ? 'image/jpeg' : 'image/png',
                    requestedFormat: isJpeg ? 'jpeg' : 'png',
                    isEmbeddedDoc: true,
                    maxBoundingBox: options.imageOptions?.maxBoundingBox || { width: 1280, height: 720 },
                    quality: options.imageOptions?.quality || 75
                  });

                  if (compResult.buffer && compResult.buffer.byteLength < rawImageBytes.length) {
                    const compU8 = new Uint8Array(compResult.buffer);
                    const newTotalBlipSize = headerPrefix.length + compU8.length;
                    const newRecLen = newTotalBlipSize - 8;

                    // Build updated BLIP
                    const newBlip = new Uint8Array(newTotalBlipSize);
                    newBlip.set(headerPrefix, 0);
                    // Update recLen in header (offset 4..7)
                    newBlip[4] = newRecLen & 0xFF;
                    newBlip[5] = (newRecLen >> 8) & 0xFF;
                    newBlip[6] = (newRecLen >> 16) & 0xFF;
                    newBlip[7] = (newRecLen >> 24) & 0xFF;
                    // Copy compressed image bytes
                    newBlip.set(compU8, headerPrefix.length);

                    compressedChunk = newBlip;
                    anyCompressed = true;
                    console.log(`[DocProcessor] Compressed PPT BLIP #${i + 1}: ${oldSize} -> ${newTotalBlipSize} bytes (-${Math.round((1 - newTotalBlipSize / oldSize) * 100)}%)`);
                  }
                } catch (e) {
                  // Keep original on error
                }
              }
            }

            const finalChunk = compressedChunk || sc.slice(oldOffset, oldOffset + oldSize);
            const finalSize = finalChunk.length;

            // If PowerPoint Document BStoreEntry exists, update size & foDelay
            if (blip.bstore && pd) {
              const b = blip.bstore;
              pd[b.sizeOffset] = finalSize & 0xFF;
              pd[b.sizeOffset + 1] = (finalSize >> 8) & 0xFF;
              pd[b.sizeOffset + 2] = (finalSize >> 16) & 0xFF;
              pd[b.sizeOffset + 3] = (finalSize >> 24) & 0xFF;

              pd[b.delayOffset] = currentNewOffset & 0xFF;
              pd[b.delayOffset + 1] = (currentNewOffset >> 8) & 0xFF;
              pd[b.delayOffset + 2] = (currentNewOffset >> 16) & 0xFF;
              pd[b.delayOffset + 3] = (currentNewOffset >> 24) & 0xFF;
            }

            newChunks.push(finalChunk);
            currentNewOffset += finalSize;

            if (onProgress && totalBlips > 0) {
              onProgress({
                phase: 'optimizing_pictures',
                progress: 30 + Math.round(((i + 1) / totalBlips) * 50)
              });
            }
          }

          if (anyCompressed) {
            // Concatenate all new BLIP chunks into the new Pictures stream
            const newPicturesStream = new Uint8Array(currentNewOffset);
            let writePos = 0;
            for (const chunk of newChunks) {
              newPicturesStream.set(chunk, writePos);
              writePos += chunk.length;
            }

            picturesEntry.content = newPicturesStream;
            picturesEntry.size = currentNewOffset;
            if (pptDocEntry && pd) {
              pptDocEntry.content = pd;
            }
            console.log(`[DocProcessor] Pictures stream reduced: ${sc.length} -> ${currentNewOffset} bytes (-${Math.round((1 - currentNewOffset / sc.length) * 100)}%)`);
          }
        }
      } catch (picErr) {
        console.warn('[DocProcessor] Picture optimization bypassed:', picErr);
      }
    }

    if (onProgress) onProgress({ phase: 'rebuilding_cfb', progress: 85 });
    const outArr = CFB.write(cfb, { type: 'array' });
    const outU8 = outArr instanceof Uint8Array ? outArr : new Uint8Array(outArr);
    const finalBuffer = outU8.byteOffset === 0 && outU8.byteLength === outU8.buffer.byteLength
      ? outU8.buffer
      : outU8.buffer.slice(outU8.byteOffset, outU8.byteOffset + outU8.byteLength);

    const outBlob = new Blob([finalBuffer], { type: 'application/vnd.ms-powerpoint' });
    if (onProgress) onProgress({ phase: 'completed', progress: 100 });

    return {
      blob: outBlob,
      buffer: finalBuffer,
      mime: 'application/vnd.ms-powerpoint'
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
