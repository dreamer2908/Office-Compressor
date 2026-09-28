/**
 * video-worker.js - High-Performance WebCodecs Video Compression Engine
 * 
 * Functions both as an Inlined Web Worker and in-thread VideoProcessor.
 * Handles MP4/MOV, MKV/WebM, and AVI container demuxing, WebCodecs VideoDecoder/VideoEncoder,
 * framerate throttling, dynamic bitrate calculations, and MP4/MKV muxing.
 * Strictly complies with single-session GPU safety and Office embedded constraints (AVC+AAC MP4 only).
 */

(function (globalScope) {
  'use strict';

  // Quality factors from webcodecs-utils
  const QUALITY_FACTORS = {
    'low': 0.05,
    'good': 0.08,
    'high': 0.10,
    'very-high': 0.15
  };

  /**
   * Calculates aspect ratio preserving video dimensions.
   * Ensures width and height are even numbers (divisible by 2) for H.264/HEVC/VP9 compatibility.
   */
  function calculateVideoDimensions(origW, origH, maxResolution) {
    if (!maxResolution || maxResolution === 'original') {
      return {
        width: (origW >> 1) << 1,
        height: (origH >> 1) << 1,
        scale: 1.0
      };
    }

    let maxW = 1920;
    let maxH = 1080;

    if (typeof maxResolution === 'string') {
      if (maxResolution === '1080p') { maxW = 1920; maxH = 1080; }
      else if (maxResolution === '720p') { maxW = 1280; maxH = 720; }
      else if (maxResolution === '480p') { maxW = 854; maxH = 480; }
    } else if (typeof maxResolution === 'object' && maxResolution.width) {
      maxW = maxResolution.width;
      maxH = maxResolution.height || maxResolution.width;
    }

    const isPortrait = origH > origW;
    const boxW = isPortrait ? Math.min(maxW, maxH) : Math.max(maxW, maxH);
    const boxH = isPortrait ? Math.max(maxW, maxH) : Math.min(maxW, maxH);

    const ratio = Math.min(boxW / origW, boxH / origH, 1.0);
    let targetW = Math.round(origW * ratio);
    let targetH = Math.round(origH * ratio);

    // Round to nearest even integer
    targetW = (targetW >> 1) << 1;
    targetH = (targetH >> 1) << 1;

    return {
      width: Math.max(2, targetW),
      height: Math.max(2, targetH),
      scale: ratio
    };
  }

  /**
   * Dynamic bitrate formula:
   * bitrate = Math.round(width * height * fps * qualityFactor)
   * Or target file size formula:
   * bitrate = ((targetBytes * 8) - (audioBitrate * duration)) / duration
   */
  function calculateTargetBitrate(params) {
    const {
      width,
      height,
      fps,
      duration = 1,
      rateControl = 'qualityFactor',
      qualityFactor = 'good',
      exactBitrate = 1500, // kbps
      targetSizeBytes = null,
      audioBitrate = 96000 // bps
    } = params;

    if (rateControl === 'bitrate') {
      return Math.round(exactBitrate * 1000);
    }

    if (rateControl === 'targetSize' && targetSizeBytes && duration > 0) {
      const targetBits = targetSizeBytes * 8;
      const audioBits = (audioBitrate || 0) * duration;
      const videoBits = Math.max(100000 * duration, targetBits - audioBits);
      const bps = Math.round(videoBits / duration);
      // Clamp between 150 kbps and 25 Mbps
      return Math.max(150000, Math.min(25000000, bps));
    }

    // Default: dynamic quality factor
    const factor = typeof qualityFactor === 'number'
      ? qualityFactor
      : (QUALITY_FACTORS[qualityFactor] || 0.08);

    const calculated = Math.round(width * height * fps * factor);
    // Sensible boundary clamps: at least 200 kbps, at most 20 Mbps
    return Math.max(200000, Math.min(20000000, calculated));
  }

  /**
   * Test browser support for video encoders
   */
  async function testSupportedCodecs() {
    if (typeof VideoEncoder === 'undefined' || !VideoEncoder.isConfigSupported) {
      return [];
    }

    const testList = [
      { name: '8-bit AVC / H.264 (High Profile)', codec: 'avc1.640028' },
      { name: '8-bit AVC / H.264 (Main Profile)', codec: 'avc1.4D401F' },
      { name: '8-bit AVC / H.264 (Baseline)', codec: 'avc1.42E01E' },
      { name: 'HEVC / H.265 (Main Profile)', codec: 'hvc1.1.6.L93.B0' },
      { name: 'VP9 (Profile 0)', codec: 'vp09.00.10.08' },
      { name: 'AV1 (Main Profile)', codec: 'av01.0.04M.08' }
    ];

    const supported = [];
    for (const item of testList) {
      try {
        const res = await VideoEncoder.isConfigSupported({
          codec: item.codec,
          width: 1280,
          height: 720,
          bitrate: 1500000,
          framerate: 30
        });
        if (res && res.supported) {
          supported.push({
            name: item.name,
            codec: item.codec,
            hardwareAcceleration: res.config ? res.config.hardwareAcceleration : 'unknown'
          });
        }
      } catch (e) {
        // Not supported
      }
    }
    return supported;
  }

  /**
   * Parse RIFF AVI container looking for H264 / AVC NAL units
   */
  function parseAviH264(buffer) {
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    if (u8.length < 12) return null;

    const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    const format = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]);
    if (magic !== 'RIFF' || format !== 'AVI ') return null;

    let width = 1920;
    let height = 1080;
    let fps = 15;
    let moviOffset = -1;
    let moviSize = 0;

    let pos = 12;
    while (pos < u8.length - 8) {
      const fourcc = String.fromCharCode(u8[pos], u8[pos+1], u8[pos+2], u8[pos+3]);
      const size = view.getUint32(pos + 4, true);

      if (fourcc === 'LIST') {
        const listType = String.fromCharCode(u8[pos+8], u8[pos+9], u8[pos+10], u8[pos+11]);
        if (listType === 'movi') {
          moviOffset = pos + 12;
          moviSize = size - 4;
          break;
        }
      } else if (fourcc === 'strh') {
        const scale = view.getUint32(pos + 28, true);
        const rate = view.getUint32(pos + 32, true);
        if (scale > 0 && rate > 0) {
          fps = Math.round((rate / scale) * 100) / 100;
        }
      } else if (fourcc === 'strf') {
        width = view.getInt32(pos + 12, true);
        height = Math.abs(view.getInt32(pos + 16, true));
      }

      pos += 8 + ((size + 1) & ~1);
    }

    if (moviOffset === -1) return null;

    const videoChunks = [];
    pos = moviOffset;
    const end = Math.min(u8.length, moviOffset + moviSize);
    let pts = 0;
    const frameIntervalUs = Math.round(1000000 / (fps || 15));

    while (pos < end - 8) {
      const tag = String.fromCharCode(u8[pos], u8[pos+1], u8[pos+2], u8[pos+3]);
      const size = view.getUint32(pos + 4, true);

      if (tag === '00dc' || tag === '00db') {
        const chunkData = u8.subarray(pos + 8, pos + 8 + size);
        let isKey = false;
        // Search for NAL units to detect keyframe (IDR = type 5)
        for (let i = 0; i < Math.min(chunkData.length - 4, 120); i++) {
          if (chunkData[i] === 0 && chunkData[i+1] === 0 && (chunkData[i+2] === 1 || (chunkData[i+2] === 0 && chunkData[i+3] === 1))) {
            const nalByte = chunkData[i+2] === 1 ? chunkData[i+3] : chunkData[i+4];
            const nalType = nalByte & 0x1F;
            if (nalType === 5 || nalType === 7) {
              isKey = true;
              break;
            }
          }
        }

        videoChunks.push({
          data: chunkData,
          pts,
          isKey
        });
        pts += frameIntervalUs;
      }

      pos += 8 + ((size + 1) & ~1);
    }

    return {
      width,
      height,
      fps,
      duration: pts / 1000000,
      chunks: videoChunks
    };
  }

  /**
   * Universal Video Processor using HTML5 <video> and canvas rendering.
   * Works on any video container and codec supported by the browser media engine.
   */
  async function transcodeViaVideoElement(fileBlob, options, onProgress) {
    const {
      targetResolution = '720p',
      targetFps = 15,
      rateControl = 'qualityFactor',
      qualityFactor = 'good',
      exactBitrate = 1500,
      targetSizeBytes = null,
      codec = 'avc1.4D401F',
      audioMode = 'aac',
      audioBitrate = 96000,
      container = 'mp4',
      isEmbeddedDoc = false
    } = options;

    const finalContainer = isEmbeddedDoc ? 'mp4' : container;
    const finalCodec = isEmbeddedDoc ? 'avc1.4D401F' : codec;
    const finalAudioMode = isEmbeddedDoc ? 'aac' : audioMode;

    const videoUrl = URL.createObjectURL(fileBlob);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = videoUrl;

    try {
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error('Failed to load video element metadata'));
      });

      const origW = video.videoWidth || 1280;
      const origH = video.videoHeight || 720;
      const duration = video.duration || 1;

      // Target dimension calculation
      const targetDim = calculateVideoDimensions(origW, origH, targetResolution);
      const outW = targetDim.width;
      const outH = targetDim.height;

      // Effective FPS
      let effectiveFps = 15;
      if (typeof targetFps === 'number') effectiveFps = targetFps;
      else if (targetFps === '30') effectiveFps = 30;
      else if (targetFps === '24') effectiveFps = 24;
      else if (targetFps === '15') effectiveFps = 15;
      else if (targetFps === '10') effectiveFps = 10;
      else effectiveFps = 24;

      // Bitrate calculation
      const videoBitrate = calculateTargetBitrate({
        width: outW,
        height: outH,
        fps: effectiveFps,
        duration,
        rateControl,
        qualityFactor,
        exactBitrate,
        targetSizeBytes,
        audioBitrate: finalAudioMode === 'mute' ? 0 : audioBitrate
      });

      console.log(`[VideoProcessor] Encoding ${origW}x${origH} -> ${outW}x${outH} @ ${effectiveFps}fps, ${Math.round(videoBitrate / 1000)}kbps (${finalCodec})`);

      // Prepare Muxer
      let muxer;
      let muxerTarget;

      if (finalContainer === 'mp4') {
        const Mp4MuxerLib = globalScope.Mp4Muxer || window.Mp4Muxer;
        if (!Mp4MuxerLib) throw new Error('Mp4Muxer library not loaded');
        muxerTarget = new Mp4MuxerLib.ArrayBufferTarget();
        muxer = new Mp4MuxerLib.Muxer({
          target: muxerTarget,
          video: {
            codec: 'avc',
            width: outW,
            height: outH
          },
          audio: finalAudioMode !== 'mute' ? {
            codec: 'aac',
            numberOfChannels: 2,
            sampleRate: 48000
          } : undefined,
          fastStart: 'in-memory'
        });
      } else {
        const WebMMuxerLib = globalScope.WebMMuxer || window.WebMMuxer;
        if (!WebMMuxerLib) throw new Error('WebMMuxer library not loaded');
        muxerTarget = new WebMMuxerLib.ArrayBufferTarget();
        muxer = new WebMMuxerLib.Muxer({
          target: muxerTarget,
          video: {
            codec: finalCodec.startsWith('vp09') ? 'V_VP9' : (finalCodec.startsWith('av01') ? 'V_AV1' : 'V_VP8'),
            width: outW,
            height: outH
          },
          audio: finalAudioMode !== 'mute' ? {
            codec: 'A_OPUS',
            numberOfChannels: 2,
            sampleRate: 48000
          } : undefined
        });
      }

      // Configure VideoEncoder
      let encoderError = null;
      const encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          muxer.addVideoChunk(chunk, metadata);
        },
        error: (e) => {
          encoderError = e;
          console.error('[VideoEncoder Error]', e);
        }
      });

      await encoder.configure({
        codec: finalCodec,
        width: outW,
        height: outH,
        bitrate: videoBitrate,
        framerate: effectiveFps,
        latencyMode: 'quality',
        avc: { format: 'avc' }
      });

      // OffscreenCanvas for rendering and scaling frames
      const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(outW, outH)
        : document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Step through video frames
      const frameStep = 1.0 / effectiveFps;
      let currentTime = 0;
      let frameIndex = 0;
      const totalFrames = Math.max(1, Math.ceil(duration * effectiveFps));

      while (currentTime < duration) {
        if (encoderError) throw encoderError;

        // Seek video
        video.currentTime = currentTime;
        await new Promise((res) => {
          video.onseeked = () => res();
        });

        // Draw and scale frame
        ctx.drawImage(video, 0, 0, outW, outH);

        // Convert canvas to VideoFrame
        const timestampUs = Math.round(currentTime * 1000000);
        const vFrame = new VideoFrame(canvas, {
          timestamp: timestampUs,
          duration: Math.round(frameStep * 1000000)
        });

        const isKeyFrame = frameIndex % (effectiveFps * 2) === 0; // Keyframe every 2 seconds
        encoder.encode(vFrame, { keyFrame: isKeyFrame });
        vFrame.close();

        frameIndex++;
        currentTime += frameStep;

        if (onProgress && frameIndex % 5 === 0) {
          const pct = Math.min(95, Math.round((frameIndex / totalFrames) * 100));
          onProgress({
            phase: 'encoding',
            progress: pct,
            currentFrame: frameIndex,
            totalFrames
          });
        }

        // Small yield for responsiveness
        if (frameIndex % 15 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      await encoder.flush();
      encoder.close();

      // Finalize Muxer
      muxer.finalize();
      const finalBuffer = muxerTarget.buffer;

      if (onProgress) {
        onProgress({ phase: 'completed', progress: 100 });
      }

      return {
        buffer: finalBuffer,
        mime: finalContainer === 'mp4' ? 'video/mp4' : 'video/x-matroska',
        width: outW,
        height: outH,
        fps: effectiveFps,
        duration,
        container: finalContainer,
        codec: finalCodec
      };
    } finally {
      URL.revokeObjectURL(videoUrl);
      video.src = '';
      video.load();
    }
  }

  /**
   * Direct AVI H264 Demuxing Pipeline
   */
  async function transcodeAviDirect(aviBuffer, options, onProgress) {
    const parsed = parseAviH264(aviBuffer);
    if (!parsed || !parsed.chunks.length) {
      // Fallback to video element
      return transcodeViaVideoElement(new Blob([aviBuffer], { type: 'video/avi' }), options, onProgress);
    }

    const {
      targetResolution = '720p',
      targetFps = 15,
      rateControl = 'qualityFactor',
      qualityFactor = 'good',
      exactBitrate = 1500,
      targetSizeBytes = null,
      codec = 'avc1.4D401F',
      container = 'mp4',
      isEmbeddedDoc = false
    } = options;

    const origW = parsed.width;
    const origH = parsed.height;
    const origFps = parsed.fps || 15;
    const targetDim = calculateVideoDimensions(origW, origH, targetResolution);
    const outW = targetDim.width;
    const outH = targetDim.height;

    let effectiveFps = typeof targetFps === 'number' ? targetFps : Math.min(origFps, 15);
    const videoBitrate = calculateTargetBitrate({
      width: outW,
      height: outH,
      fps: effectiveFps,
      duration: parsed.duration,
      rateControl,
      qualityFactor,
      exactBitrate,
      targetSizeBytes,
      audioBitrate: 0
    });

    const Mp4MuxerLib = globalScope.Mp4Muxer || window.Mp4Muxer;
    if (!Mp4MuxerLib) throw new Error('Mp4Muxer library not loaded');
    const muxerTarget = new Mp4MuxerLib.ArrayBufferTarget();
    const muxer = new Mp4MuxerLib.Muxer({
      target: muxerTarget,
      video: {
        codec: 'avc',
        width: outW,
        height: outH
      },
      fastStart: 'in-memory'
    });

    let encoderError = null;
    const encoder = new VideoEncoder({
      output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
      error: (e) => { encoderError = e; console.error('[Encoder Error]', e); }
    });

    await encoder.configure({
      codec: 'avc1.4D401F',
      width: outW,
      height: outH,
      bitrate: videoBitrate,
      framerate: effectiveFps,
      latencyMode: 'quality',
      avc: { format: 'avc' }
    });

    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(outW, outH)
      : document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    let encodedFrameCount = 0;
    const minIntervalUs = Math.round(1000000 / effectiveFps);
    let lastEncodedTimestampUs = -minIntervalUs;

    // Decoder for incoming H264 chunks
    let decoderError = null;
    const decoder = new VideoDecoder({
      output: (frame) => {
        // Frame rate thinning
        if (frame.timestamp - lastEncodedTimestampUs >= minIntervalUs * 0.85) {
          ctx.drawImage(frame, 0, 0, outW, outH);
          const scaledFrame = new VideoFrame(canvas, {
            timestamp: frame.timestamp,
            duration: minIntervalUs
          });
          const isKey = encodedFrameCount % (effectiveFps * 2) === 0;
          encoder.encode(scaledFrame, { keyFrame: isKey });
          scaledFrame.close();
          lastEncodedTimestampUs = frame.timestamp;
          encodedFrameCount++;
        }
        frame.close();
      },
      error: (e) => { decoderError = e; console.error('[Decoder Error]', e); }
    });

    await decoder.configure({
      codec: 'avc1.4D401F',
      codedWidth: origW,
      codedHeight: origH,
      hardwareAcceleration: 'prefer-hardware'
    });

    const totalChunks = parsed.chunks.length;
    for (let i = 0; i < totalChunks; i++) {
      if (encoderError) throw encoderError;
      if (decoderError) throw decoderError;

      const chunk = parsed.chunks[i];
      const encodedChunk = new EncodedVideoChunk({
        type: chunk.isKey ? 'key' : 'delta',
        timestamp: chunk.pts,
        duration: Math.round(1000000 / origFps),
        data: chunk.data
      });

      decoder.decode(encodedChunk);

      if (onProgress && i % 10 === 0) {
        onProgress({
          phase: 'processing',
          progress: Math.round((i / totalChunks) * 90),
          currentFrame: i,
          totalFrames: totalChunks
        });
      }
    }

    await decoder.flush();
    decoder.close();

    await encoder.flush();
    encoder.close();

    muxer.finalize();
    if (onProgress) onProgress({ phase: 'completed', progress: 100 });

    return {
      buffer: muxerTarget.buffer,
      mime: 'video/mp4',
      width: outW,
      height: outH,
      fps: effectiveFps,
      duration: parsed.duration,
      container: 'mp4',
      codec: 'avc1.4D401F'
    };
  }

  /**
   * Main entry point for video compression.
   * Manages hardware concurrency (strict sequential lock: 1 session at a time).
   */
  let videoProcessingLock = Promise.resolve();

  async function compressVideo(inputBlobOrBuffer, options = {}, onProgress = null) {
    // Acquire sequential queue lock to prevent GPU QuotaExceededError
    let releaseLock;
    const lockWait = new Promise((res) => { releaseLock = res; });
    const currentLock = videoProcessingLock;
    videoProcessingLock = videoProcessingLock.then(() => lockWait);

    await currentLock;

    try {
      const isBuffer = inputBlobOrBuffer instanceof ArrayBuffer;
      const buffer = isBuffer ? inputBlobOrBuffer : await inputBlobOrBuffer.arrayBuffer();
      const blob = isBuffer ? new Blob([inputBlobOrBuffer]) : inputBlobOrBuffer;

      // Check if AVI with H.264
      const u8 = new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength));
      const isAvi = u8.length >= 12 &&
        String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) === 'RIFF' &&
        String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) === 'AVI ';

      if (isAvi) {
        try {
          return await transcodeAviDirect(buffer, options, onProgress);
        } catch (e) {
          console.warn('[VideoProcessor] Direct AVI decoding failed, falling back to Video element:', e);
        }
      }

      // Universal HTML5 Video + WebCodecs Encoder pipeline
      return await transcodeViaVideoElement(blob, options, onProgress);
    } finally {
      releaseLock();
    }
  }

  // Web Worker message dispatcher
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && !self.document) {
    self.onmessage = async function (e) {
      const { id, data, options } = e.data;
      try {
        const result = await compressVideo(data, options, (progress) => {
          self.postMessage({ id, type: 'progress', progress });
        });

        self.postMessage({
          id,
          type: 'complete',
          success: true,
          result: {
            buffer: result.buffer,
            mime: result.mime,
            width: result.width,
            height: result.height,
            fps: result.fps,
            duration: result.duration,
            container: result.container,
            codec: result.codec
          }
        }, [result.buffer]);
      } catch (err) {
        self.postMessage({
          id,
          type: 'complete',
          success: false,
          error: err.message || String(err)
        });
      }
    };
  }

  // Export for main thread
  const VideoProcessor = {
    compressVideo,
    testSupportedCodecs,
    calculateVideoDimensions,
    calculateTargetBitrate,
    QUALITY_FACTORS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = VideoProcessor;
  } else {
    globalScope.VideoProcessor = VideoProcessor;
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this)));
