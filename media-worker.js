/**
 * media-worker.js - Unified High-Performance Media Compression Engine
 * 
 * Powered by a custom WebAssembly build of libav.js (FFmpeg 6.1) and WebCodecs.
 * Operates both as a Web Worker (instantiated via dynamic Blob URL) and in-thread MediaProcessor.
 * 
 * Features:
 * 1. Unified Ingest & Discovery: Demuxes MP4/MOV, MKV/WebM, MPEG-TS (.MTS/.M2TS), ASF/WMV, AVI, FLV, MP3, WAV, FLAC, OGG.
 * 2. Pipeline 1 (Video):
 *    - Modern codecs (AVC/H.264, HEVC, VP8, VP9, AV1) decoded via browser hardware VideoDecoder with libav software fallback.
 *    - Legacy codecs (WMV1, WMV2, MPEG-4, MJPEG, MPEG-2) decoded via libav software decoders.
 *    - OffscreenCanvas display aspect ratio correction (e.g. anamorphic Sony MTS 1440x1080 -> 16:9 1920x1080) and bounding box downscaling.
 *    - PTS frame throttling to target framerates (15fps, 10fps, or original).
 *    - WebCodecs VideoEncoder dynamic bitrate encoding.
 *    - Audio decoding (AC-3, WMA, MP3, AAC, PCM) with multi-channel to stereo/mono downmixing, resampled and encoded via libav native AAC encoder.
 *    - Muxing into compliant MP4 or MKV containers.
 * 3. Pipeline 2 (Audio-Only):
 *    - Standalone or embedded document audio (.wav, .mp3, .wma, .m4a, .aac, .flac, .ogg).
 *    - Skips all canvas and video initialization.
 *    - Decodes to Float32 PCM, downmixes to stereo/mono, resamples, encodes to AAC, and muxes to .m4a.
 * 4. Strictly compliant with Office embedded media constraints (AVC + AAC in MP4 only).
 */

(function (globalScope) {
  'use strict';

  const QUALITY_FACTORS = {
    'low': 0.05,
    'good': 0.08,
    'high': 0.10,
    'very-high': 0.15
  };

  const AUDIO_EXT_REGEX = /\.(m4a|aac|mp3|wav|ogg|oga|flac|opus|wma)$/i;

  // LibAV Codec IDs
  const CODEC_IDS = {
    H264: 27,
    HEVC: 172,
    VP8: 139,
    VP9: 166,
    AV1: 222,
    WMV1: 17,
    WMV2: 8,
    MPEG4: 12,
    MJPEG: 7,
    MPEG2VIDEO: 2,
    AAC: 86018,
    AC3: 86019,
    MP3: 86017,
    FLAC: 86028,
    OPUS: 86076,
    WMAV2: 86024
  };

  // Cached LibAV instance
  let _libavPromise = null;

  async function getLibavInstance(options = {}) {
    if (_libavPromise) return _libavPromise;

    _libavPromise = (async () => {
      let LibAVFactory = null;
      if (typeof globalScope.LibAV !== 'undefined') {
        LibAVFactory = globalScope.LibAV;
      } else if (typeof window !== 'undefined' && window.LibAV) {
        LibAVFactory = window.LibAV;
      }

      // Determine absolute or relative base directory
      let base = options.base;
      if (!base) {
        if (typeof location !== 'undefined' && location.href && !location.href.startsWith('blob:')) {
          base = new URL('libs', location.href).href;
        } else {
          base = './libs';
        }
      }
      base = base.replace(/\/+$/, '');

      const wasmurl = options.wasmurl || (base + '/libav-6.10.9.0-webcodecs-custom.wasm.wasm');
      const libavUrl = options.libavUrl || (base + '/libav-6.10.9.0-webcodecs-custom.js');

      if (!LibAVFactory && typeof importScripts === 'function') {
        // In Web Worker: resolve libav script path
        try {
          importScripts(libavUrl);
          LibAVFactory = globalScope.LibAV || self.LibAV;
        } catch (e) {
          console.warn('[MediaWorker] Failed to load libav via importScripts:', libavUrl, e);
        }
      }

      if (!LibAVFactory) {
        throw new Error('LibAV library is not available in environment');
      }

      LibAVFactory.base = base;
      LibAVFactory.wasmurl = wasmurl;
      const libav = await LibAVFactory.LibAV({
        base: base,
        wasmurl: wasmurl,
        noworker: true
      });
      return libav;
    })().catch(err => {
      _libavPromise = null;
      throw err;
    });

    return _libavPromise;
  }

  // --- Dimension, Bitrate & Codec Calculation Helpers ---

  function calculateVideoDimensions(origW, origH, maxResolution) {
    if (!maxResolution || maxResolution === 'original') {
      return {
        width: Math.max(2, (origW >> 1) << 1),
        height: Math.max(2, (origH >> 1) << 1),
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

    targetW = (targetW >> 1) << 1;
    targetH = (targetH >> 1) << 1;

    return {
      width: Math.max(2, targetW),
      height: Math.max(2, targetH),
      scale: ratio
    };
  }

  function ensureValidAvcCodec(codecStr, width, height) {
    if (!codecStr || !codecStr.startsWith('avc1.')) return codecStr;
    const pixels = width * height;
    const profile = codecStr.slice(5, 7);
    let levelHex = codecStr.slice(9, 11).toUpperCase();
    let levelVal = parseInt(levelHex, 16) || 30;

    let minLevel = 30; // Level 3.0 (480p)
    if (pixels > 921600) minLevel = 40; // Level 4.0 (1080p)
    else if (pixels > 414720) minLevel = 31; // Level 3.1 (720p)

    if (levelVal < minLevel) {
      levelVal = minLevel;
      levelHex = levelVal.toString(16).toUpperCase().padStart(2, '0');
      return `avc1.${profile}${codecStr.slice(7, 9)}${levelHex}`;
    }
    return codecStr;
  }

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
      const videoBits = Math.max(150000 * duration, targetBits - audioBits);
      const bps = Math.round(videoBits / duration);
      return Math.max(150000, Math.min(25000000, bps));
    }

    const factor = typeof qualityFactor === 'number'
      ? qualityFactor
      : (QUALITY_FACTORS[qualityFactor] || 0.08);

    const calculated = Math.round(width * height * fps * factor);
    return Math.max(200000, Math.min(20000000, calculated));
  }

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
      } catch (e) {}
    }
    return supported;
  }

  // --- H.264 SPS & NAL Bitstream Helpers ---

  class ExpGolombReader {
    constructor(buffer) {
      this.buffer = buffer;
      this.byteOffset = 0;
      this.bitOffset = 0;
    }
    readBit() {
      if (this.byteOffset >= this.buffer.length) return 0;
      const bit = (this.buffer[this.byteOffset] >> (7 - this.bitOffset)) & 1;
      this.bitOffset++;
      if (this.bitOffset === 8) {
        this.bitOffset = 0;
        this.byteOffset++;
      }
      return bit;
    }
    readBits(n) {
      let val = 0;
      for (let i = 0; i < n; i++) val = (val << 1) | this.readBit();
      return val;
    }
    readExpGolomb() {
      let leadingZeros = 0;
      while (this.readBit() === 0 && leadingZeros < 32) leadingZeros++;
      if (leadingZeros === 0) return 0;
      return (1 << leadingZeros) - 1 + this.readBits(leadingZeros);
    }
    readSignedExpGolomb() {
      const val = this.readExpGolomb();
      return (val & 1) ? (val + 1) / 2 : -(val / 2);
    }
  }

  function parseSpsInfo(sps) {
    if (!sps || sps.length < 4) return null;
    const profile = sps[1];
    const level = sps[3];
    const reader = new ExpGolombReader(sps.subarray(4));
    reader.readExpGolomb(); // seq_parameter_set_id

    if ([100, 110, 122, 244, 44, 83, 86, 118, 128].includes(profile)) {
      const chroma = reader.readExpGolomb();
      if (chroma === 3) reader.readBit();
      reader.readExpGolomb();
      reader.readExpGolomb();
      reader.readBit();
      if (reader.readBit()) {
        const count = chroma !== 3 ? 8 : 12;
        for (let i = 0; i < count; i++) {
          if (reader.readBit()) {
            let lastScale = 8, nextScale = 8;
            const size = i < 6 ? 16 : 64;
            for (let j = 0; j < size; j++) {
              if (nextScale !== 0) {
                const delta = reader.readSignedExpGolomb();
                nextScale = (lastScale + delta + 256) % 256;
              }
              lastScale = nextScale === 0 ? lastScale : nextScale;
            }
          }
        }
      }
    }

    reader.readExpGolomb(); // log2_max_frame_num_minus4
    const pocType = reader.readExpGolomb();
    if (pocType === 0) reader.readExpGolomb();
    else if (pocType === 1) {
      reader.readBit();
      reader.readSignedExpGolomb();
      reader.readSignedExpGolomb();
      const numRef = reader.readExpGolomb();
      for (let i = 0; i < numRef; i++) reader.readSignedExpGolomb();
    }

    reader.readExpGolomb(); // max_num_ref_frames
    reader.readBit(); // gaps_in_frame_num_value_allowed_flag
    const picWidthInMbsMinus1 = reader.readExpGolomb();
    const picHeightInMapUnitsMinus1 = reader.readExpGolomb();
    const frameMbsOnlyFlag = reader.readBit();
    if (!frameMbsOnlyFlag) reader.readBit();
    reader.readBit(); // direct_8x8_inference_flag

    let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
    if (reader.readBit()) {
      cropLeft = reader.readExpGolomb();
      cropRight = reader.readExpGolomb();
      cropTop = reader.readExpGolomb();
      cropBottom = reader.readExpGolomb();
    }

    const codedWidth = (picWidthInMbsMinus1 + 1) * 16 - (cropLeft + cropRight) * 2;
    const codedHeight = (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16 - (cropTop + cropBottom) * 2;

    let sarW = 1, sarH = 1;
    if (reader.readBit()) { // vui_parameters_present_flag
      if (reader.readBit()) { // aspect_ratio_info_present_flag
        const aspectIdc = reader.readBits(8);
        if (aspectIdc === 255) {
          sarW = reader.readBits(16);
          sarH = reader.readBits(16);
        } else {
          const sarTable = {
            1: [1, 1], 2: [12, 11], 3: [10, 11], 4: [16, 11], 5: [40, 33],
            6: [24, 11], 7: [20, 11], 8: [32, 11], 9: [80, 33], 10: [18, 11],
            11: [15, 11], 12: [64, 33], 13: [160, 99], 14: [4, 3], 15: [3, 2], 16: [2, 1]
          };
          if (sarTable[aspectIdc]) [sarW, sarH] = sarTable[aspectIdc];
        }
      }
    }

    let displayWidth = codedWidth;
    if (sarW > 0 && sarH > 0) displayWidth = Math.round(codedWidth * (sarW / sarH));
    if (codedWidth === 1440 && (codedHeight >= 1070 && codedHeight <= 1090)) displayWidth = 1920;

    return {
      profile,
      level,
      codedWidth,
      codedHeight,
      displayWidth,
      displayHeight: codedHeight,
      sarW,
      sarH,
      codec: `avc1.${sps[1].toString(16).padStart(2, '0')}${sps[2].toString(16).padStart(2, '0')}${sps[3].toString(16).padStart(2, '0')}`
    };
  }

  function createAvcC(sps, pps) {
    const avcc = new Uint8Array(11 + sps.length + pps.length);
    avcc[0] = 1; // configurationVersion
    avcc[1] = sps[1]; // profile_idc
    avcc[2] = sps[2]; // profile_compatibility
    avcc[3] = sps[3]; // level_idc
    avcc[4] = 0xff; // 6 bits reserved + lengthSizeMinusOne (3 = 4-byte lengths)
    avcc[5] = 0xe1; // 3 bits reserved + numOfSequenceParameterSets (1)
    avcc[6] = (sps.length >> 8) & 0xff;
    avcc[7] = sps.length & 0xff;
    avcc.set(sps, 8);
    const ppsPos = 8 + sps.length;
    avcc[ppsPos] = 1; // numOfPictureParameterSets
    avcc[ppsPos + 1] = (pps.length >> 8) & 0xff;
    avcc[ppsPos + 2] = pps.length & 0xff;
    avcc.set(pps, ppsPos + 3);
    return avcc;
  }

  function extractAnnexBNals(bytes) {
    const nals = [];
    let i = 0;
    const len = bytes.length;
    let start = -1;
    let prefixLen = 0;

    while (i < len - 2) {
      let pLen = 0;
      if (bytes[i] === 0 && bytes[i + 1] === 0) {
        if (bytes[i + 2] === 1) pLen = 3;
        else if (i < len - 3 && bytes[i + 2] === 0 && bytes[i + 3] === 1) pLen = 4;
      }
      if (pLen > 0) {
        if (start !== -1) {
          nals.push(bytes.subarray(start + prefixLen, i));
        }
        start = i;
        prefixLen = pLen;
        i += pLen;
      } else {
        i++;
      }
    }
    if (start !== -1) {
      nals.push(bytes.subarray(start + prefixLen));
    }
    return nals;
  }

  function annexBToAvcc(bytes) {
    const nals = extractAnnexBNals(bytes);
    if (nals.length === 0) return { data: bytes, isKey: false };
    let totalLen = 0;
    for (const n of nals) totalLen += 4 + n.length;
    const out = new Uint8Array(totalLen);
    const view = new DataView(out.buffer);
    let pos = 0;
    let isKey = false;
    for (const n of nals) {
      view.setUint32(pos, n.length, false);
      out.set(n, pos + 4);
      pos += 4 + n.length;
      const nalType = n[0] & 0x1f;
      if (nalType === 5) isKey = true; // IDR keyframe
    }
    return { data: out, isKey };
  }

  function extractPackedI420(frame) {
    if (!frame || !frame.data) return null;
    const w = frame.width;
    const h = frame.height;
    if (!w || !h) return null;

    if (Array.isArray(frame.data)) {
      const yLen = w * h;
      const uvLen = (w >> 1) * (h >> 1);
      const buf = new Uint8Array(yLen + uvLen * 2);
      buf.set(frame.data[0].subarray(0, yLen), 0);
      buf.set(frame.data[1].subarray(0, uvLen), yLen);
      buf.set(frame.data[2].subarray(0, uvLen), yLen + uvLen);
      return buf;
    }

    if (frame.layout && frame.layout.length >= 3) {
      const yStride = frame.layout[0].stride;
      const yOffset = frame.layout[0].offset;
      const uStride = frame.layout[1].stride;
      const uOffset = frame.layout[1].offset;
      const vStride = frame.layout[2].stride;
      const vOffset = frame.layout[2].offset;

      const packed = new Uint8Array(w * h + (w >> 1) * (h >> 1) * 2);
      let dstOff = 0;
      for (let r = 0; r < h; r++) {
        packed.set(frame.data.subarray(yOffset + r * yStride, yOffset + r * yStride + w), dstOff);
        dstOff += w;
      }
      const uvH = h >> 1;
      const uvW = w >> 1;
      for (let r = 0; r < uvH; r++) {
        packed.set(frame.data.subarray(uOffset + r * uStride, uOffset + r * uStride + uvW), dstOff);
        dstOff += uvW;
      }
      for (let r = 0; r < uvH; r++) {
        packed.set(frame.data.subarray(vOffset + r * vStride, vOffset + r * vStride + uvW), dstOff);
        dstOff += uvW;
      }
      return packed;
    }

    return null;
  }

  // --- Audio DSP & Downmixing Helpers ---

  function extractPcmFromFrame(frame, origChannels) {
    if (!frame || !frame.data) return null;
    const nbSamples = frame.nb_samples || 0;
    if (nbSamples === 0) return null;

    const planes = [];
    const channels = frame.channels || origChannels || 1;

    if (Array.isArray(frame.data)) {
      for (let c = 0; c < channels; c++) {
        const srcPlane = frame.data[c];
        if (!srcPlane) {
          planes.push(new Float32Array(nbSamples));
          continue;
        }
        if (srcPlane instanceof Float32Array) {
          planes.push(srcPlane);
        } else if (srcPlane instanceof Int16Array) {
          const f32 = new Float32Array(srcPlane.length);
          for (let i = 0; i < srcPlane.length; i++) f32[i] = srcPlane[i] / 32768.0;
          planes.push(f32);
        } else if (srcPlane instanceof Int32Array) {
          const f32 = new Float32Array(srcPlane.length);
          for (let i = 0; i < srcPlane.length; i++) f32[i] = srcPlane[i] / 2147483648.0;
          planes.push(f32);
        } else if (srcPlane instanceof Uint8Array) {
          const f32 = new Float32Array(srcPlane.length);
          for (let i = 0; i < srcPlane.length; i++) f32[i] = (srcPlane[i] - 128) / 128.0;
          planes.push(f32);
        } else {
          planes.push(new Float32Array(srcPlane));
        }
      }
    } else {
      const raw = frame.data;
      for (let c = 0; c < channels; c++) {
        const plane = new Float32Array(nbSamples);
        if (raw instanceof Float32Array) {
          for (let i = 0; i < nbSamples; i++) plane[i] = raw[i * channels + c] || 0;
        } else if (raw instanceof Int16Array) {
          for (let i = 0; i < nbSamples; i++) plane[i] = (raw[i * channels + c] || 0) / 32768.0;
        } else if (raw instanceof Int32Array) {
          for (let i = 0; i < nbSamples; i++) plane[i] = (raw[i * channels + c] || 0) / 2147483648.0;
        } else if (raw instanceof Uint8Array) {
          for (let i = 0; i < nbSamples; i++) plane[i] = ((raw[i * channels + c] || 0) - 128) / 128.0;
        } else {
          for (let i = 0; i < nbSamples; i++) plane[i] = raw[i * channels + c] || 0;
        }
        planes.push(plane);
      }
    }
    return planes;
  }

  function downmixAndResample(pcmPlanes, origChannels, origSampleRate, targetChannels, targetSampleRate) {
    const numSamples = pcmPlanes[0].length;
    let mixedPlanes = [];

    if (targetChannels === 1) {
      if (origChannels === 1) {
        mixedPlanes = [pcmPlanes[0]];
      } else if (origChannels === 2) {
        const mono = new Float32Array(numSamples);
        const ch0 = pcmPlanes[0], ch1 = pcmPlanes[1];
        for (let i = 0; i < numSamples; i++) {
          mono[i] = 0.5 * (ch0[i] + ch1[i]);
        }
        mixedPlanes = [mono];
      } else {
        // Multi-channel downmix to mono
        const mono = new Float32Array(numSamples);
        const scale = 1.0 / origChannels;
        for (let c = 0; c < origChannels; c++) {
          const ch = pcmPlanes[c] || pcmPlanes[0];
          for (let i = 0; i < numSamples; i++) {
            mono[i] += ch[i] * scale;
          }
        }
        mixedPlanes = [mono];
      }
    } else { // targetChannels === 2
      if (origChannels === 2) {
        mixedPlanes = [pcmPlanes[0], pcmPlanes[1]];
      } else if (origChannels === 1) {
        mixedPlanes = [pcmPlanes[0], pcmPlanes[0]];
      } else {
        // 5.1/multi-channel to stereo ITU downmix
        const left = new Float32Array(numSamples);
        const right = new Float32Array(numSamples);
        const fl = pcmPlanes[0];
        const fr = pcmPlanes[1];
        const fc = origChannels > 2 ? pcmPlanes[2] : fl;
        const bl = origChannels > 4 ? pcmPlanes[4] : fl;
        const br = origChannels > 5 ? pcmPlanes[5] : fr;
        const cGain = 0.7071, sGain = 0.7071;
        for (let i = 0; i < numSamples; i++) {
          const c = fc[i] * cGain;
          left[i] = Math.max(-1.0, Math.min(1.0, fl[i] + c + (bl[i] * sGain)));
          right[i] = Math.max(-1.0, Math.min(1.0, fr[i] + c + (br[i] * sGain)));
        }
        mixedPlanes = [left, right];
      }
    }

    if (origSampleRate === targetSampleRate) {
      return mixedPlanes;
    }

    // Linear resampling
    const ratio = origSampleRate / targetSampleRate;
    const outSamples = Math.floor(numSamples / ratio);
    const resampledPlanes = [];

    for (let ch = 0; ch < targetChannels; ch++) {
      const src = mixedPlanes[ch];
      const dst = new Float32Array(outSamples);
      for (let i = 0; i < outSamples; i++) {
        const srcPos = i * ratio;
        const srcIdx = Math.floor(srcPos);
        const frac = srcPos - srcIdx;
        const s0 = src[srcIdx] || 0;
        const s1 = src[Math.min(srcIdx + 1, numSamples - 1)] || s0;
        dst[i] = s0 + frac * (s1 - s0);
      }
      resampledPlanes.push(dst);
    }

    return resampledPlanes;
  }

  // --- Pipeline 2: Audio-Only Processing ---

  async function processAudioPipeline(libav, fmt_ctx, aStream, options, onProgress) {
    if (onProgress) onProgress({ progress: 10, phase: 'Initializing audio decoder' });

    const [dec_codec, c_dec, dec_pkt, dec_frame] = await libav.ff_init_decoder(aStream.codec_id, {
      codecpar: aStream.codecpar
    });

    const cp = await libav.ff_copyout_codecpar(aStream.codecpar);
    const origChannels = cp.channels || 2;
    const origSampleRate = cp.sample_rate || 48000;

    let targetChannels = 2;
    if (options.audioChannels === 'mono') targetChannels = 1;
    else if (options.audioChannels === 'stereo') targetChannels = 2;
    else if (options.audioChannels === 'original') targetChannels = origChannels <= 2 ? origChannels : 2;

    const targetSampleRate = 48000;
    const targetBitrate = Number(options.audioBitrate) || 96000;

    if (onProgress) onProgress({ progress: 20, phase: 'Decoding audio stream' });

    const demuxPkt = await libav.av_packet_alloc();
    const decodedPcmPlanes = [];
    for (let c = 0; c < origChannels; c++) decodedPcmPlanes.push([]);

    while (true) {
      const [res, outPackets] = await libav.ff_read_frame_multi(fmt_ctx, demuxPkt, { limit: 512 * 1024 });
      const pkts = outPackets[aStream.index] || [];
      if (pkts.length > 0) {
        const frames = await libav.ff_decode_multi(c_dec, dec_pkt, dec_frame, pkts);
        for (const f of frames) {
          const planes = extractPcmFromFrame(f, origChannels);
          if (planes) {
            for (let c = 0; c < origChannels; c++) {
              if (planes[c]) decodedPcmPlanes[c].push(planes[c]);
            }
          }
        }
      }
      if (res === libav.AVERROR_EOF || (res === 0 && pkts.length === 0)) break;
    }

    await libav.av_packet_free_js(demuxPkt);
    await libav.ff_free_decoder(c_dec, dec_pkt, dec_frame);

    if (onProgress) onProgress({ progress: 45, phase: 'Mixing & resampling audio' });

    // Flatten decoded planes
    const flatPlanes = [];
    for (let c = 0; c < origChannels; c++) {
      let totalLen = 0;
      for (const chunk of decodedPcmPlanes[c]) totalLen += chunk.length;
      const flat = new Float32Array(totalLen);
      let offset = 0;
      for (const chunk of decodedPcmPlanes[c]) {
        flat.set(chunk, offset);
        offset += chunk.length;
      }
      flatPlanes.push(flat);
    }

    if (flatPlanes.length === 0 || flatPlanes[0].length === 0) {
      throw new Error('No audio frames decoded from stream');
    }

    const processedPlanes = downmixAndResample(flatPlanes, origChannels, origSampleRate, targetChannels, targetSampleRate);

    const isOpus = !options.isEmbeddedDoc && (options.audioMode === 'opus' || options.audioCodec === 'opus');
    const audioEncoderName = isOpus ? 'libopus' : 'aac';
    const audioSampleFmt = isOpus ? 3 : 8; // 3 = AV_SAMPLE_FMT_FLT (interleaved), 8 = AV_SAMPLE_FMT_FLTP (planar)

    if (onProgress) onProgress({ progress: 60, phase: `Encoding ${isOpus ? 'Opus' : 'AAC'} via libav` });

    const [enc_codec, c_enc, enc_frame, enc_pkt, enc_frame_size] = await libav.ff_init_encoder(audioEncoderName, {
      ctx: {
        sample_rate: targetSampleRate,
        sample_fmt: audioSampleFmt,
        bit_rate: targetBitrate,
        channels: targetChannels,
        channel_layout: targetChannels === 1 ? 4 : 3
      },
      time_base: [1, targetSampleRate]
    });

    const frameSize = enc_frame_size || (isOpus ? 960 : 1024);
    const outExt = isOpus ? (options.container === 'mkv' ? 'mkv' : 'opus') : 'm4a';
    const outMime = isOpus ? (options.container === 'mkv' ? 'audio/x-matroska' : 'audio/opus') : 'audio/mp4';
    const outFileName = 'output_' + Date.now() + '.' + outExt;

    const aPar = await libav.avcodec_parameters_alloc();
    await libav.avcodec_parameters_from_context(aPar, c_enc);

    const [oc, fmt, pb, sts] = await libav.ff_init_muxer(
      { filename: outFileName, open: true, codecpars: true },
      [[aPar, 1, targetSampleRate]]
    );
    await libav.avformat_write_header(oc, 0);

    const totalSamples = processedPlanes[0].length;
    const encodeFrames = [];
    let pts = 0;

    for (let s = 0; s < totalSamples; s += frameSize) {
      const count = Math.min(frameSize, totalSamples - s);
      let frameData;
      if (isOpus) {
        const interleaved = new Float32Array(frameSize * targetChannels);
        for (let i = 0; i < count; i++) {
          interleaved[i * targetChannels] = processedPlanes[0][s + i];
          if (targetChannels === 2) {
            interleaved[i * targetChannels + 1] = processedPlanes[1][s + i];
          }
        }
        frameData = interleaved;
      } else {
        const plane0 = new Float32Array(frameSize);
        plane0.set(processedPlanes[0].subarray(s, s + count));
        const plane1 = targetChannels === 2 ? new Float32Array(frameSize) : null;
        if (plane1) {
          plane1.set(processedPlanes[1].subarray(s, s + count));
        }
        frameData = targetChannels === 1 ? [plane0] : [plane0, plane1];
      }

      encodeFrames.push({
        data: frameData,
        channels: targetChannels,
        channel_layout: targetChannels === 1 ? 4 : 3,
        format: audioSampleFmt,
        nb_samples: frameSize,
        sample_rate: targetSampleRate,
        pts: pts,
        time_base_num: 1,
        time_base_den: targetSampleRate
      });
      pts += frameSize;
    }

    const audioPackets = await libav.ff_encode_multi(c_enc, enc_frame, enc_pkt, encodeFrames, { fin: true });

    let minAudioPts = 0;
    for (const ap of audioPackets) {
      if (ap.pts < minAudioPts) minAudioPts = ap.pts;
    }
    const audioPtsOffset = minAudioPts < 0 ? -minAudioPts : 0;

    const muxList = [];
    for (const ap of audioPackets) {
      muxList.push({
        type: 'a',
        data: ap.data,
        pts: ap.pts + audioPtsOffset,
        dts: (ap.dts !== undefined ? ap.dts : ap.pts) + audioPtsOffset,
        duration: ap.duration || frameSize,
        flags: ap.flags || 1,
        stream_index: 0,
        time_base_num: 1,
        time_base_den: targetSampleRate
      });
    }

    const muxPkt = await libav.av_packet_alloc();
    await libav.ff_write_multi(oc, muxPkt, muxList);
    await libav.av_write_trailer(oc);
    await libav.ff_free_muxer(oc, pb);
    await libav.av_packet_free_js(muxPkt);
    await libav.avcodec_parameters_free_js(aPar);
    await libav.ff_free_encoder(c_enc, enc_frame, enc_pkt);

    const outBytes = await libav.readFile(outFileName);
    await libav.unlink(outFileName);

    if (onProgress) onProgress({ progress: 100, phase: 'Completed' });

    return {
      buffer: outBytes.buffer,
      blob: new Blob([outBytes], { type: outMime }),
      mime: outMime,
      container: outExt,
      duration: totalSamples / targetSampleRate
    };
  }

  // --- Pipeline 1: Video Processing (Video + Audio OR Video Only) ---

  async function processVideoPipeline(libav, fmt_ctx, streams, options, onProgress) {
    const vStream = streams.find(s => s.codec_type === 0);
    if (!vStream) throw new Error('No video stream found in media file');

    const aStream = streams.find(s => s.codec_type === 1);
    const cp = await libav.ff_copyout_codecpar(vStream.codecpar);

    // Compute display dimensions with SAR correction
    const codedW = cp.width || 1280;
    const codedH = cp.height || 720;
    let sarNum = cp.sample_aspect_ratio_num || 1;
    let sarDen = cp.sample_aspect_ratio_den || 1;

    // Sony MTS 1440x1080 anamorphic correction
    if (codedW === 1440 && (codedH >= 1070 && codedH <= 1090)) {
      sarNum = 4;
      sarDen = 3;
    }

    let displayW = codedW;
    if (sarNum > 0 && sarDen > 0) {
      displayW = Math.round(codedW * (sarNum / sarDen));
    }

    const { width: outW, height: outH } = calculateVideoDimensions(displayW, codedH, options.targetResolution);

    // Framerate & bitrate
    let origFps = 30;
    if (vStream.framerate_num && vStream.framerate_den && vStream.framerate_den > 0) {
      origFps = Math.round(vStream.framerate_num / vStream.framerate_den);
    } else if (vStream.time_base_num && vStream.time_base_den && vStream.time_base_den > 0) {
      const calcFps = Math.round(vStream.time_base_den / vStream.time_base_num);
      if (calcFps >= 1 && calcFps <= 120) origFps = calcFps;
    }
    if (origFps < 1 || origFps > 120) origFps = 30;

    const targetFps = options.targetFps === 'original' || !options.targetFps ? origFps : Math.min(origFps, Number(options.targetFps));
    const bitrate = calculateTargetBitrate({
      width: outW,
      height: outH,
      fps: targetFps,
      duration: options.duration || 1,
      rateControl: options.rateControl || 'qualityFactor',
      qualityFactor: options.qualityFactor || 'good',
      exactBitrate: options.exactBitrate || 1500,
      targetSizeBytes: options.targetSizeBytes || null,
      audioBitrate: options.audioBitrate || 96000
    });

    const isEmbedded = !!options.isEmbeddedDoc;
    const finalContainer = isEmbedded ? 'mp4' : (options.container === 'mkv' ? 'mkv' : 'mp4');
    const finalCodecStr = ensureValidAvcCodec(isEmbedded ? 'avc1.4D401F' : (options.codec || 'avc1.4D401F'), outW, outH);

    // Determine if hardware WebCodecs VideoDecoder can be used
    const isModernCodec = [CODEC_IDS.H264, CODEC_IDS.HEVC, CODEC_IDS.VP8, CODEC_IDS.VP9, CODEC_IDS.AV1].includes(vStream.codec_id);

    // Demux all packets
    if (onProgress) onProgress({ progress: 15, phase: 'Demuxing streams' });
    const demuxPkt = await libav.av_packet_alloc();
    const videoPackets = [];
    const audioPackets = [];

    while (true) {
      const [res, outPackets] = await libav.ff_read_frame_multi(fmt_ctx, demuxPkt, { limit: 1024 * 1024 });
      if (outPackets[vStream.index]) videoPackets.push(...outPackets[vStream.index]);
      if (aStream && outPackets[aStream.index]) audioPackets.push(...outPackets[aStream.index]);
      if (res === libav.AVERROR_EOF || (res === 0 && (!outPackets[vStream.index] || outPackets[vStream.index].length === 0))) break;
    }
    await libav.av_packet_free_js(demuxPkt);

    if (videoPackets.length === 0) throw new Error('No video packets demuxed');

    // Video Output Array
    const encodedVideoChunks = [];

    // Setup VideoEncoder
    let encoderError = null;
    let avcExtradata = null;
    const videoEncoder = new VideoEncoder({
      output: (chunk, metadata) => {
        if (metadata && metadata.decoderConfig && metadata.decoderConfig.description && !avcExtradata) {
          avcExtradata = new Uint8Array(metadata.decoderConfig.description);
        }
        const chunkData = new Uint8Array(chunk.byteLength);
        chunk.copyTo(chunkData);
        encodedVideoChunks.push({
          data: chunkData,
          type: chunk.type,
          timestamp: chunk.timestamp,
          duration: chunk.duration,
          metadata
        });
      },
      error: (e) => { encoderError = e; console.error('[VideoEncoder Error]', e); }
    });

    await videoEncoder.configure({
      codec: finalCodecStr,
      width: outW,
      height: outH,
      bitrate: bitrate,
      framerate: targetFps,
      hardwareAcceleration: 'no-preference',
      avc: { format: 'avc' }
    });

    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext('2d');

    const minIntervalUs = Math.round(1000000 / targetFps);
    let lastEncodedTimestampUs = -Infinity;
    let encodedFrameIndex = 0;

    function processAndEncodeFrame(frame) {
      const ptsUs = Math.round(frame.timestamp);
      if (lastEncodedTimestampUs !== -Infinity && (ptsUs - lastEncodedTimestampUs) < (minIntervalUs * 0.75)) {
        frame.close();
        return;
      }
      ctx.drawImage(frame, 0, 0, outW, outH);
      frame.close();

      const outTimestampUs = Math.round(encodedFrameIndex * minIntervalUs);
      const scaledFrame = new VideoFrame(canvas, {
        timestamp: outTimestampUs,
        duration: minIntervalUs
      });
      const isKey = (encodedFrameIndex % (targetFps * 2)) === 0;
      videoEncoder.encode(scaledFrame, { keyFrame: isKey });
      scaledFrame.close();

      lastEncodedTimestampUs = ptsUs;
      encodedFrameIndex++;
    }

    // Decoding Strategy:
    let useHardwareDecoder = isModernCodec && typeof VideoDecoder !== 'undefined';
    let spsInfo = null;
    let avccDesc = null;
    const isAvcc = !!(cp.extradata && cp.extradata.length > 0 && cp.extradata[0] === 1);

    if (useHardwareDecoder && vStream.codec_id === CODEC_IDS.H264) {
      // Parse SPS/PPS for AVC
      if (isAvcc) {
        avccDesc = cp.extradata;
      } else if (cp.extradata && cp.extradata.length > 0) {
        const nals = extractAnnexBNals(cp.extradata);
        let sps = null, pps = null;
        for (const n of nals) {
          const t = n[0] & 0x1f;
          if (t === 7 && !sps) sps = n;
          if (t === 8 && !pps) pps = n;
        }
        if (sps && pps) {
          spsInfo = parseSpsInfo(sps);
          avccDesc = createAvcC(sps, pps);
        }
      }
      if (!avccDesc) {
        // Try to find SPS/PPS in first video packets
        for (const vp of videoPackets.slice(0, 10)) {
          const nals = extractAnnexBNals(vp.data);
          let sps = null, pps = null;
          for (const n of nals) {
            const t = n[0] & 0x1f;
            if (t === 7 && !sps) sps = n;
            if (t === 8 && !pps) pps = n;
          }
          if (sps && pps) {
            spsInfo = parseSpsInfo(sps);
            avccDesc = createAvcC(sps, pps);
            break;
          }
        }
      }
    }

    // Timestamp analysis (handles AVI or streams with missing/zero PTS)
    let hasValidPts = false;
    if (videoPackets.length > 1) {
      for (let k = 1; k < Math.min(15, videoPackets.length); k++) {
        if (videoPackets[k].pts !== undefined && videoPackets[k].pts !== null && videoPackets[k].pts > 0) {
          hasValidPts = true;
          break;
        }
      }
    }
    let hasValidDts = false;
    if (!hasValidPts && videoPackets.length > 1) {
      for (let k = 1; k < Math.min(15, videoPackets.length); k++) {
        if (videoPackets[k].dts !== undefined && videoPackets[k].dts !== null && videoPackets[k].dts > 0) {
          hasValidDts = true;
          break;
        }
      }
    }

    if (onProgress) onProgress({ progress: 25, phase: 'Decoding & filtering video' });

    if (useHardwareDecoder) {
      try {
        let decoderError = null;
        const videoDecoder = new VideoDecoder({
          output: (frame) => {
            processAndEncodeFrame(frame);
          },
          error: (e) => { decoderError = e; console.error('[VideoDecoder Error]', e); }
        });

        const decCodec = (spsInfo && spsInfo.codec) ? spsInfo.codec : (vStream.codec_id === CODEC_IDS.HEVC ? 'hvc1.1.6.L93.B0' : 'avc1.4D401F');
        const decConfig = {
          codec: decCodec,
          hardwareAcceleration: 'no-preference'
        };
        if (avccDesc) {
          decConfig.description = avccDesc;
        }
        await videoDecoder.configure(decConfig);

        const totalPkts = videoPackets.length;
        const tbNum = vStream.time_base_num || 1;
        const tbDen = vStream.time_base_den || 90000;

        for (let i = 0; i < totalPkts; i++) {
          if (encoderError) throw encoderError;
          if (decoderError) throw decoderError;

          while (videoDecoder.decodeQueueSize > 15 || videoEncoder.encodeQueueSize > 15) {
            await new Promise(r => setTimeout(r, 8));
          }

          const p = videoPackets[i];
          let ptsUs = 0;
          if (hasValidPts && p.pts !== undefined && p.pts !== null && (p.pts !== 0 || i === 0)) {
            ptsUs = Math.round((p.pts * tbNum / tbDen) * 1e6);
          } else if (hasValidDts && p.dts !== undefined && p.dts !== null) {
            ptsUs = Math.round((p.dts * tbNum / tbDen) * 1e6);
          } else {
            ptsUs = Math.round((i / origFps) * 1e6);
          }

          let chunkData = p.data;
          let isKey = !!(p.flags & 1);

          if (!isAvcc && vStream.codec_id === CODEC_IDS.H264) {
            const avccChunk = annexBToAvcc(p.data);
            chunkData = avccChunk.data;
            if (avccChunk.isKey) isKey = true;
          }

          const encChunk = new EncodedVideoChunk({
            type: isKey ? 'key' : 'delta',
            timestamp: ptsUs,
            data: chunkData
          });
          videoDecoder.decode(encChunk);

          if (onProgress && i % 25 === 0) {
            const pct = Math.min(75, 25 + Math.round((i / totalPkts) * 50));
            onProgress({ progress: pct, phase: 'Transcoding video frames' });
          }
        }

        await videoDecoder.flush();
        videoDecoder.close();
      } catch (hwErr) {
        console.warn('[MediaWorker] Hardware VideoDecoder failed:', hwErr);
        if ([CODEC_IDS.H264, CODEC_IDS.HEVC, CODEC_IDS.VP8, CODEC_IDS.VP9, CODEC_IDS.AV1].includes(vStream.codec_id)) {
          throw new Error('Hardware VideoDecoder failed for ' + (spsInfo?.codec || 'AVC/HEVC') + ': ' + (hwErr.message || hwErr));
        }
        useHardwareDecoder = false;
      }
    }

    if (!useHardwareDecoder) {
      // LibAV Software Decoder Path (for WMV1, MPEG-4, MJPEG, or hardware fallback)
      const [dec_codec, c_dec, dec_pkt, dec_frame] = await libav.ff_init_decoder(vStream.codec_id, {
        codecpar: vStream.codecpar
      });

      const totalPkts = videoPackets.length;
      const tbNum = vStream.time_base_num || 1;
      const tbDen = vStream.time_base_den || 90000;
      let softwareDecodedCount = 0;

      for (let i = 0; i < totalPkts; i += 20) {
        if (encoderError) throw encoderError;
        while (videoEncoder.encodeQueueSize > 15) {
          await new Promise(r => setTimeout(r, 8));
        }
        const batch = videoPackets.slice(i, i + 20);
        const frames = await libav.ff_decode_multi(c_dec, dec_pkt, dec_frame, batch);

        for (const f of frames) {
          let ptsUs = 0;
          if (hasValidPts && f.pts !== undefined && f.pts !== null && (f.pts !== 0 || softwareDecodedCount === 0)) {
            ptsUs = Math.round((f.pts * tbNum / tbDen) * 1e6);
          } else if (hasValidDts && f.pkt_dts !== undefined && f.pkt_dts !== null) {
            ptsUs = Math.round((f.pkt_dts * tbNum / tbDen) * 1e6);
          } else {
            ptsUs = Math.round((softwareDecodedCount / origFps) * 1e6);
          }
          softwareDecodedCount++;

          const i420Data = extractPackedI420(f);
          if (i420Data) {
            const vf = new VideoFrame(i420Data, {
              format: 'I420',
              codedWidth: f.width,
              codedHeight: f.height,
              timestamp: ptsUs
            });
            processAndEncodeFrame(vf);
          }
        }

        if (onProgress) {
          const pct = Math.min(75, 25 + Math.round((i / totalPkts) * 50));
          onProgress({ progress: pct, phase: 'Software decoding & transcoding frames' });
        }
      }

      await libav.ff_free_decoder(c_dec, dec_pkt, dec_frame);
    }

    await videoEncoder.flush();
    videoEncoder.close();

    // Process Audio Track (if present and not muted)
    let encodedAudioPackets = [];
    let audioTargetSampleRate = 48000;
    let aPar = null;

    const isOpus = !isEmbedded && (options.audioMode === 'opus' || options.audioCodec === 'opus');
    const audioEncoderName = isOpus ? 'libopus' : 'aac';
    const audioSampleFmt = isOpus ? 3 : 8; // 3 = AV_SAMPLE_FMT_FLT (interleaved float), 8 = AV_SAMPLE_FMT_FLTP (planar float)

    if (aStream && options.audioMode !== 'mute') {
      if (onProgress) onProgress({ progress: 80, phase: `Transcoding audio track (${isOpus ? 'Opus' : 'AAC'}) via libav` });
      const [a_dec_codec, a_c_dec, a_dec_pkt, a_dec_frame] = await libav.ff_init_decoder(aStream.codec_id, {
        codecpar: aStream.codecpar
      });

      const aCp = await libav.ff_copyout_codecpar(aStream.codecpar);
      const aOrigCh = aCp.channels || 2;
      const aOrigSr = aCp.sample_rate || 48000;

      const aDecodedPlanes = [];
      for (let c = 0; c < aOrigCh; c++) aDecodedPlanes.push([]);

      for (let i = 0; i < audioPackets.length; i += 20) {
        const batch = audioPackets.slice(i, i + 20);
        const aFrames = await libav.ff_decode_multi(a_c_dec, a_dec_pkt, a_dec_frame, batch);
        for (const af of aFrames) {
          const planes = extractPcmFromFrame(af, aOrigCh);
          if (planes) {
            for (let c = 0; c < aOrigCh; c++) {
              if (planes[c]) aDecodedPlanes[c].push(planes[c]);
            }
          }
        }
      }

      await libav.ff_free_decoder(a_c_dec, a_dec_pkt, a_dec_frame);

      // Flatten & downmix
      const aFlatPlanes = [];
      for (let c = 0; c < aOrigCh; c++) {
        let totalLen = 0;
        for (const chunk of aDecodedPlanes[c]) totalLen += chunk.length;
        const flat = new Float32Array(totalLen);
        let offset = 0;
        for (const chunk of aDecodedPlanes[c]) {
          flat.set(chunk, offset);
          offset += chunk.length;
        }
        aFlatPlanes.push(flat);
      }

      if (aFlatPlanes.length > 0 && aFlatPlanes[0].length > 0) {
        const aTargetCh = options.audioChannels === 'mono' ? 1 : 2;
        const aTargetBitrate = Number(options.audioBitrate) || 96000;
        const aProcessed = downmixAndResample(aFlatPlanes, aOrigCh, aOrigSr, aTargetCh, audioTargetSampleRate);

        const [a_enc_codec, a_c_enc, a_enc_frame, a_enc_pkt, a_enc_fs] = await libav.ff_init_encoder(audioEncoderName, {
          ctx: {
            sample_rate: audioTargetSampleRate,
            sample_fmt: audioSampleFmt,
            bit_rate: aTargetBitrate,
            channels: aTargetCh,
            channel_layout: aTargetCh === 1 ? 4 : 3
          },
          time_base: [1, audioTargetSampleRate]
        });

        const frameSize = a_enc_fs || (isOpus ? 960 : 1024);
        const aTotalS = aProcessed[0].length;
        const aEncFrames = [];
        let aPts = 0;
        for (let s = 0; s < aTotalS; s += frameSize) {
          const count = Math.min(frameSize, aTotalS - s);
          let frameData;
          if (isOpus) {
            const interleaved = new Float32Array(frameSize * aTargetCh);
            for (let i = 0; i < count; i++) {
              interleaved[i * aTargetCh] = aProcessed[0][s + i];
              if (aTargetCh === 2) {
                interleaved[i * aTargetCh + 1] = aProcessed[1][s + i];
              }
            }
            frameData = interleaved;
          } else {
            const p0 = new Float32Array(frameSize);
            p0.set(aProcessed[0].subarray(s, s + count));
            const p1 = aTargetCh === 2 ? new Float32Array(frameSize) : null;
            if (p1) p1.set(aProcessed[1].subarray(s, s + count));
            frameData = aTargetCh === 1 ? [p0] : [p0, p1];
          }

          aEncFrames.push({
            data: frameData,
            channels: aTargetCh,
            channel_layout: aTargetCh === 1 ? 4 : 3,
            format: audioSampleFmt,
            nb_samples: frameSize,
            sample_rate: audioTargetSampleRate,
            pts: aPts,
            time_base_num: 1,
            time_base_den: audioTargetSampleRate
          });
          aPts += frameSize;
        }

        encodedAudioPackets = await libav.ff_encode_multi(a_c_enc, a_enc_frame, a_enc_pkt, aEncFrames, { fin: true });

        aPar = await libav.avcodec_parameters_alloc();
        await libav.avcodec_parameters_from_context(aPar, a_c_enc);
        await libav.ff_free_encoder(a_c_enc, a_enc_frame, a_enc_pkt);
      }
    }

    // Mux final media container
    if (onProgress) onProgress({ progress: 90, phase: 'Muxing output container via libav' });

    const outExt = finalContainer === 'mkv' ? 'mkv' : 'mp4';
    const outFileName = 'final_media_' + Date.now() + '.' + outExt;

    // Build video codecpar with extradata and format
    const vPar = await libav.avcodec_parameters_alloc();
    await libav.ff_copyin_codecpar(vPar, {
      codec_type: 0,
      codec_id: finalCodecStr.startsWith('hvc') ? CODEC_IDS.HEVC : CODEC_IDS.H264,
      width: outW,
      height: outH,
      format: 0, // AV_PIX_FMT_YUV420P
      extradata: avcExtradata || new Uint8Array(0)
    });

    const streamSpecs = [
      [vPar, 1, 1000000] // Video: timebase 1/1,000,000 (microseconds)
    ];

    if (aPar && encodedAudioPackets.length > 0) {
      streamSpecs.push([aPar, 1, audioTargetSampleRate]);
    }

    const [oc, fmt, pb, sts] = await libav.ff_init_muxer(
      { filename: outFileName, open: true, codecpars: true },
      streamSpecs
    );
    await libav.avformat_write_header(oc, 0);

    const muxPkt = await libav.av_packet_alloc();

    // Prepare interleaved packets
    const muxList = [];
    for (const vc of encodedVideoChunks) {
      muxList.push({
        type: 'v',
        data: vc.data,
        pts: vc.timestamp,
        dts: vc.timestamp,
        flags: vc.type === 'key' ? 1 : 0,
        stream_index: 0,
        time_base_num: 1,
        time_base_den: 1000000
      });
    }

    if (encodedAudioPackets.length > 0) {
      let minAudioPts = 0;
      for (const ap of encodedAudioPackets) {
        if (ap.pts < minAudioPts) minAudioPts = ap.pts;
      }
      const audioPtsOffset = minAudioPts < 0 ? -minAudioPts : 0;

      for (const ap of encodedAudioPackets) {
        const adjPts = ap.pts + audioPtsOffset;
        const adjDts = (ap.dts !== undefined ? ap.dts : ap.pts) + audioPtsOffset;
        const audioPtsUs = Math.round((adjPts / audioTargetSampleRate) * 1e6);
        muxList.push({
          type: 'a',
          data: ap.data,
          pts: adjPts,
          dts: adjDts,
          duration: ap.duration || (isOpus ? 960 : 1024),
          flags: ap.flags || 1,
          stream_index: 1,
          time_base_num: 1,
          time_base_den: audioTargetSampleRate,
          ptsUs: audioPtsUs
        });
      }
    }

    // Sort by timestamp for proper interleaving
    muxList.sort((a, b) => {
      const ptsA = a.type === 'v' ? a.pts : a.ptsUs;
      const ptsB = b.type === 'v' ? b.pts : b.ptsUs;
      return ptsA - ptsB;
    });

    await libav.ff_write_multi(oc, muxPkt, muxList);
    await libav.av_write_trailer(oc);
    await libav.ff_free_muxer(oc, pb);
    await libav.av_packet_free_js(muxPkt);
    await libav.avcodec_parameters_free_js(vPar);
    if (aPar) await libav.avcodec_parameters_free_js(aPar);

    const outBytes = await libav.readFile(outFileName);
    await libav.unlink(outFileName);

    if (onProgress) onProgress({ progress: 100, phase: 'Completed' });

    return {
      buffer: outBytes.buffer,
      blob: new Blob([outBytes], { type: finalContainer === 'mp4' ? 'video/mp4' : 'video/x-matroska' }),
      mime: finalContainer === 'mp4' ? 'video/mp4' : 'video/x-matroska',
      width: outW,
      height: outH,
      fps: targetFps,
      duration: encodedFrameIndex / targetFps,
      container: finalContainer,
      codec: finalCodecStr
    };
  }

  // --- Main Media Router ---

  async function compressMedia(inputBlobOrBuffer, options = {}, onProgress = null) {
    if (onProgress) onProgress({ progress: 5, phase: 'Loading libav engine' });
    const libav = await getLibavInstance(options);

    const isBuffer = inputBlobOrBuffer instanceof ArrayBuffer;
    const arrayBuffer = isBuffer ? inputBlobOrBuffer : await inputBlobOrBuffer.arrayBuffer();
    const inputU8 = new Uint8Array(arrayBuffer);

    const inFileName = 'in_media_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    await libav.writeFile(inFileName, inputU8);

    let fmt_ctx = 0;
    try {
      const [ctx, streams] = await libav.ff_init_demuxer_file(inFileName);
      fmt_ctx = ctx;

      const videoStreams = streams.filter(s => s.codec_type === 0);
      const audioStreams = streams.filter(s => s.codec_type === 1);

      const isAudioOnly = options.mode === 'audio-only' ||
        videoStreams.length === 0 ||
        AUDIO_EXT_REGEX.test(options.filename || '');

      if (isAudioOnly) {
        if (audioStreams.length === 0) {
          throw new Error('No audio stream found in media input');
        }
        return await processAudioPipeline(libav, fmt_ctx, audioStreams[0], options, onProgress);
      } else {
        return await processVideoPipeline(libav, fmt_ctx, streams, options, onProgress);
      }
    } finally {
      if (fmt_ctx) {
        try { await libav.avformat_close_input_js(fmt_ctx); } catch (e) {}
      }
      try { await libav.unlink(inFileName); } catch (e) {}
    }
  }

  // --- Web Worker Dispatcher ---

  if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && !self.document) {
    self.onmessage = async function (e) {
      const { id, data, options } = e.data;
      try {
        const result = await compressMedia(data, options, (progress) => {
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
        console.error('[MediaWorker Job Error]', err);
        self.postMessage({
          id,
          type: 'complete',
          success: false,
          error: err.message || String(err)
        });
      }
    };
  }

  // --- Main Thread Client & In-Thread Fallback ---

  let _workerInstance = null;
  const _pendingJobs = new Map();
  let _sequentialLock = Promise.resolve();

  function getActiveWorker() {
    if (!_workerInstance && typeof window !== 'undefined') {
      try {
        const scriptEl = typeof document !== 'undefined' ? document.querySelector('script[src*="media-worker.js"]') : null;
        let workerUrl = (scriptEl && scriptEl.src) ? scriptEl.src : new URL('media-worker.js', window.location.origin + '/').href;
        
        const blobCode = `importScripts(${JSON.stringify(workerUrl)});`;
        const blob = new Blob([blobCode], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        _workerInstance = new Worker(blobUrl);

        _workerInstance.onmessage = function (e) {
          const { id, type, progress, success, result, error } = e.data;
          const job = _pendingJobs.get(id);
          if (!job) return;

          if (type === 'progress') {
            if (job.onProgress) job.onProgress(progress);
          } else if (type === 'complete') {
            _pendingJobs.delete(id);
            if (success) job.resolve(result);
            else job.reject(new Error(error || 'Media compression failed'));
          }
        };

        _workerInstance.onerror = function (e) {
          console.error('[MediaWorker Thread Error]', e);
          _workerInstance = null;
        };
      } catch (e) {
        console.warn('[MediaProcessor] Could not instantiate Web Worker, using in-thread pipeline:', e);
        _workerInstance = null;
      }
    }
    return _workerInstance;
  }

  async function compressMediaClient(inputBlobOrBuffer, options = {}, onProgress = null) {
    let release;
    const lockWait = new Promise((res) => { release = res; });
    const currentLock = _sequentialLock;
    _sequentialLock = _sequentialLock.then(() => lockWait);
    await currentLock;

    try {
      const isBuffer = inputBlobOrBuffer instanceof ArrayBuffer;
      const buffer = isBuffer ? inputBlobOrBuffer : await inputBlobOrBuffer.arrayBuffer();
      const filename = options.filename || (inputBlobOrBuffer.name || 'media');

      // Resolve libav paths for worker
      const scriptEl = typeof document !== 'undefined' ? (document.querySelector('script[src*="media-worker.js"]') || document.querySelector('script[src*="loader.js"]')) : null;
      const baseOrigin = scriptEl && scriptEl.src ? new URL('./', scriptEl.src).href : (typeof window !== 'undefined' ? window.location.origin + '/' : './');
      const libavBase = (options.base || new URL('libs', baseOrigin).href).replace(/\/+$/, '');
      const libavUrl = options.libavUrl || (libavBase + '/libav-6.10.9.0-webcodecs-custom.js');
      const wasmurl = options.wasmurl || (libavBase + '/libav-6.10.9.0-webcodecs-custom.wasm.wasm');

      const worker = getActiveWorker();
      if (worker) {
        const id = 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        return await new Promise((resolve, reject) => {
          _pendingJobs.set(id, { resolve, reject, onProgress });
          worker.postMessage({ id, data: buffer, options: { ...options, libavUrl, base: libavBase, wasmurl, filename } }, [buffer]);
        });
      }

      // Fallback: in-thread processing
      return await compressMedia(buffer, { ...options, libavUrl, base: libavBase, wasmurl, filename }, onProgress);
    } finally {
      release();
    }
  }

  const MediaProcessor = {
    compressMedia: compressMediaClient,
    compressVideo: compressMediaClient,
    compressAudio: (input, opts, prog) => compressMediaClient(input, { ...opts, mode: 'audio-only' }, prog),
    testSupportedCodecs,
    calculateVideoDimensions,
    calculateTargetBitrate,
    QUALITY_FACTORS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MediaProcessor;
  } else {
    globalScope.MediaProcessor = MediaProcessor;
    // Backwards compatibility aliases
    globalScope.VideoProcessor = MediaProcessor;
    globalScope.AudioProcessor = MediaProcessor;
  }

})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this)));
