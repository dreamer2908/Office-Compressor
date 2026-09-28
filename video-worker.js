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
   * Helper: Bit reader for SPS parsing
   */
  class ExpGolombReader {
    constructor(buffer) {
      this.buffer = buffer;
      this.byteOffset = 0;
      this.bitOffset = 0;
    }
    readBit() {
      if (this.byteOffset >= this.buffer.length) return 0;
      const val = (this.buffer[this.byteOffset] >> (7 - this.bitOffset)) & 1;
      this.bitOffset++;
      if (this.bitOffset === 8) {
        this.bitOffset = 0;
        this.byteOffset++;
      }
      return val;
    }
    readBits(n) {
      let res = 0;
      for (let i = 0; i < n; i++) res = (res << 1) | this.readBit();
      return res;
    }
    readUE() {
      let zeros = 0;
      while (this.readBit() === 0 && zeros < 32) zeros++;
      if (zeros === 0) return 0;
      return (1 << zeros) - 1 + this.readBits(zeros);
    }
    readSE() {
      const ue = this.readUE();
      return (ue % 2 === 1) ? ((ue + 1) >> 1) : -(ue >> 1);
    }
  }

  /**
   * Remove emulation prevention bytes (0x00 0x00 0x03 -> 0x00 0x00)
   */
  function removeEmulationPrevention(buf) {
    const res = [];
    for (let i = 0; i < buf.length; i++) {
      if (i >= 2 && buf[i] === 3 && buf[i - 1] === 0 && buf[i - 2] === 0) continue;
      res.push(buf[i]);
    }
    return new Uint8Array(res);
  }

  /**
   * Create AVCDecoderConfigurationRecord (avcC) from SPS and PPS
   */
  function createAvcC(sps, pps) {
    const totalLen = 11 + sps.length + pps.length;
    const avcc = new Uint8Array(totalLen);
    avcc[0] = 1; // configurationVersion
    avcc[1] = sps[1]; // AVCProfileIndication
    avcc[2] = sps[2]; // profile_compatibility
    avcc[3] = sps[3]; // AVCLevelIndication
    avcc[4] = 0xff; // 6 bits reserved (111111) + 2 bits lengthSizeMinusOne (3 -> 4 bytes)
    avcc[5] = 0xe1; // 3 bits reserved (111) + 5 bits numOfSequenceParameterSets (1)
    avcc[6] = (sps.length >> 8) & 0xff;
    avcc[7] = sps.length & 0xff;
    avcc.set(sps, 8);
    let offset = 8 + sps.length;
    avcc[offset] = 1; // numOfPictureParameterSets (1)
    avcc[offset + 1] = (pps.length >> 8) & 0xff;
    avcc[offset + 2] = pps.length & 0xff;
    avcc.set(pps, offset + 3);
    return avcc;
  }

  /**
   * Parse SPS to extract profile, level, dimensions, and display aspect ratio
   */
  function parseSpsInfo(rawSps) {
    const clean = removeEmulationPrevention(rawSps);
    const reader = new ExpGolombReader(clean);
    reader.readBits(8); // skip forbidden_zero_bit, nal_ref_idc, nal_unit_type
    const profileIdc = reader.readBits(8);
    const constraintFlags = reader.readBits(8);
    const levelIdc = reader.readBits(8);
    const codec = `avc1.${profileIdc.toString(16).padStart(2, '0')}${constraintFlags.toString(16).padStart(2, '0')}${levelIdc.toString(16).padStart(2, '0')}`.toLowerCase();
    reader.readUE(); // seq_parameter_set_id

    if ([100, 110, 122, 244, 44, 83, 86, 118, 128].includes(profileIdc)) {
      const chromaFormatIdc = reader.readUE();
      if (chromaFormatIdc === 3) reader.readBits(1);
      reader.readUE(); // bit_depth_luma_minus8
      reader.readUE(); // bit_depth_chroma_minus8
      reader.readBits(1); // qpprime_y_zero_transform_bypass_flag
      const seqScalingMatrixPresent = reader.readBits(1);
      if (seqScalingMatrixPresent) {
        const count = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < count; i++) {
          if (reader.readBits(1)) {
            const size = i < 6 ? 16 : 64;
            let lastScale = 8, nextScale = 8;
            for (let j = 0; j < size; j++) {
              if (nextScale !== 0) {
                const delta = reader.readSE();
                nextScale = (lastScale + delta + 256) % 256;
              }
              lastScale = nextScale === 0 ? lastScale : nextScale;
            }
          }
        }
      }
    }

    reader.readUE(); // log2_max_frame_num_minus4
    const picOrderCntType = reader.readUE();
    if (picOrderCntType === 0) {
      reader.readUE(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
      reader.readBits(1);
      reader.readSE();
      reader.readSE();
      const numRef = reader.readUE();
      for (let i = 0; i < numRef; i++) reader.readSE();
    }

    reader.readUE(); // max_num_ref_frames
    reader.readBits(1); // gaps_in_frame_num_value_allowed_flag
    const picWidthInMbsMinus1 = reader.readUE();
    const picHeightInMapUnitsMinus1 = reader.readUE();
    const frameMbsOnlyFlag = reader.readBits(1);
    if (!frameMbsOnlyFlag) reader.readBits(1); // mb_adaptive_frame_field_flag
    reader.readBits(1); // direct_8x8_inference_flag
    const frameCroppingFlag = reader.readBits(1);
    let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
    if (frameCroppingFlag) {
      cropLeft = reader.readUE();
      cropRight = reader.readUE();
      cropTop = reader.readUE();
      cropBottom = reader.readUE();
    }

    const codedWidth = (picWidthInMbsMinus1 + 1) * 16 - (cropLeft + cropRight) * 2;
    const codedHeight = ((2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16) - (cropTop + cropBottom) * 2;

    let sarW = 1, sarH = 1;
    const vuiPresent = reader.readBits(1);
    if (vuiPresent) {
      const aspectRatioPresent = reader.readBits(1);
      if (aspectRatioPresent) {
        const aspectIdc = reader.readBits(8);
        if (aspectIdc === 255) {
          sarW = reader.readBits(16);
          sarH = reader.readBits(16);
        } else {
          const sarTable = {
            1: [1, 1], 2: [12, 11], 3: [10, 11], 4: [16, 11],
            5: [40, 33], 6: [24, 11], 7: [20, 11], 8: [32, 11],
            9: [80, 33], 10: [18, 11], 11: [15, 11], 12: [64, 33],
            13: [160, 99], 14: [4, 3], 15: [3, 2], 16: [2, 1]
          };
          if (sarTable[aspectIdc]) [sarW, sarH] = sarTable[aspectIdc];
        }
      }
    }

    let displayWidth = Math.round(codedWidth * (sarW / sarH));
    let displayHeight = codedHeight;
    // Common Sony anamorphic 1440x1080 -> 1920x1080 normalization
    if (codedWidth === 1440 && (codedHeight >= 1070 && codedHeight <= 1090)) {
      displayWidth = 1920;
      displayHeight = 1080;
    }

    return {
      codec,
      profileIdc,
      levelIdc,
      codedWidth,
      codedHeight,
      displayWidth,
      displayHeight
    };
  }

  /**
   * Parse MPEG-TS / M2TS / MTS container and extract H.264 Elementary Stream
   */
  function parseMtsH264(buffer) {
    const u8 = new Uint8Array(buffer);
    if (u8.length < 192) return null;

    // Detect packet size: 192 bytes (BDAV/M2TS with 4-byte TP_extra_header) vs 188 bytes (standard TS)
    let packetSize = 188;
    let offset = 0;

    if (u8[4] === 0x47 && u8[4 + 192] === 0x47 && (u8.length < 4 + 384 || u8[4 + 384] === 0x47)) {
      packetSize = 192;
      offset = 4;
    } else if (u8[0] === 0x47 && u8[188] === 0x47 && (u8.length < 376 || u8[376] === 0x47)) {
      packetSize = 188;
      offset = 0;
    } else {
      // Scan first 1000 bytes for repeating sync byte
      let found = false;
      for (let s = 0; s < Math.min(1000, u8.length - 384); s++) {
        if (u8[s] === 0x47 && u8[s + 192] === 0x47 && u8[s + 384] === 0x47) {
          packetSize = 192;
          offset = s % 192;
          found = true;
          break;
        } else if (u8[s] === 0x47 && u8[s + 188] === 0x47 && u8[s + 376] === 0x47) {
          packetSize = 188;
          offset = s % 188;
          found = true;
          break;
        }
      }
      if (!found) return null;
    }

    let pmtPid = null;
    let videoPid = null;
    let audioPid = null;
    const totalPackets = Math.floor((u8.length - offset) / packetSize);

    // Scan PAT and PMT to find Video and Audio PIDs
    const scanLimit = Math.min(totalPackets, 3000);
    for (let i = 0; i < scanLimit; i++) {
      const pStart = i * packetSize + offset;
      if (u8[pStart] !== 0x47) continue;

      const b1 = u8[pStart + 1];
      const b2 = u8[pStart + 2];
      const b3 = u8[pStart + 3];
      const pusi = (b1 & 0x40) !== 0;
      const pid = ((b1 & 0x1f) << 8) | b2;
      const afc = (b3 & 0x30) >> 4;
      let p = pStart + 4;
      if (afc === 2 || afc === 3) p += 1 + u8[p];
      if (p >= pStart + 188) continue;

      // PAT (PID 0)
      if (pid === 0 && !pmtPid) {
        if (pusi) p += 1 + u8[p];
        if (u8[p] === 0x00) {
          const secLen = ((u8[p + 1] & 0x0f) << 8) | u8[p + 2];
          for (let ep = p + 8; ep < p + 3 + secLen - 4; ep += 4) {
            const progNum = (u8[ep] << 8) | u8[ep + 1];
            const progPid = ((u8[ep + 2] & 0x1f) << 8) | u8[ep + 3];
            if (progNum !== 0) {
              pmtPid = progPid;
              break;
            }
          }
        }
      }

      // PMT
      if (pmtPid && pid === pmtPid && (!videoPid || !audioPid)) {
        if (pusi) p += 1 + u8[p];
        if (u8[p] === 0x02) {
          const secLen = ((u8[p + 1] & 0x0f) << 8) | u8[p + 2];
          const progInfoLen = ((u8[p + 10] & 0x0f) << 8) | u8[p + 11];
          let ep = p + 12 + progInfoLen;
          const endEp = p + 3 + secLen - 4;
          while (ep < endEp) {
            const st = u8[ep];
            const ePid = ((u8[ep + 1] & 0x1f) << 8) | u8[ep + 2];
            const esLen = ((u8[ep + 3] & 0x0f) << 8) | u8[ep + 4];
            if (st === 0x1b && !videoPid) { // H.264 Video
              videoPid = ePid;
            } else if ((st === 0x81 || st === 0x06 || st === 0x82 || st === 0x83 || st === 0x84 || st === 0x85 || st === 0x86) && !audioPid) {
              // AC-3 / Dolby Audio stream
              audioPid = ePid;
            }
            ep += 5 + esLen;
          }
        }
      }

      if (videoPid && audioPid) break;
    }

    if (!videoPid) videoPid = 0x1011; // Standard Sony HDR camcorder Video PID fallback
    if (!audioPid) audioPid = 0x1100; // Standard Sony HDR camcorder Audio PID fallback

    // Reassemble PES packets for Video and Audio
    const pesList = [];
    let curPes = null;
    const audioPesList = [];
    let curAudioPes = null;

    for (let i = 0; i < totalPackets; i++) {
      const pStart = i * packetSize + offset;
      if (u8[pStart] !== 0x47) continue;

      const b1 = u8[pStart + 1];
      const b2 = u8[pStart + 2];
      const b3 = u8[pStart + 3];
      const pusi = (b1 & 0x40) !== 0;
      const pid = ((b1 & 0x1f) << 8) | b2;
      const afc = (b3 & 0x30) >> 4;
      let p = pStart + 4;
      if (afc === 2 || afc === 3) p += 1 + u8[p];
      if (p >= pStart + 188) continue;

      if (pid === videoPid) {
        const chunk = u8.subarray(p, pStart + 188);
        if (pusi) {
          if (curPes) pesList.push(curPes);
          curPes = [chunk];
        } else if (curPes) {
          curPes.push(chunk);
        }
      } else if (pid === audioPid) {
        const chunk = u8.subarray(p, pStart + 188);
        if (pusi) {
          if (curAudioPes) audioPesList.push(curAudioPes);
          curAudioPes = [chunk];
        } else if (curAudioPes) {
          curAudioPes.push(chunk);
        }
      }
    }
    if (curPes) pesList.push(curPes);
    if (curAudioPes) audioPesList.push(curAudioPes);
    if (!pesList.length) return null;

    // Scan for SPS and PPS
    let sps = null;
    let pps = null;

    for (let i = 0; i < Math.min(u8.length - 200, 1000000); i++) {
      if (u8[i] === 0 && u8[i+1] === 0 && ((u8[i+2] === 1) || (u8[i+2] === 0 && u8[i+3] === 1))) {
        const start = u8[i+2] === 1 ? i + 3 : i + 4;
        const nalType = u8[start] & 0x1f;
        if (nalType === 7 && !sps) {
          let end = start + 1;
          for (; end < start + 250; end++) {
            if (u8[end] === 0 && u8[end+1] === 0 && ((u8[end+2] === 1) || (u8[end+2] === 0 && u8[end+3] === 1))) break;
          }
          sps = u8.subarray(start, end);
        } else if (nalType === 8 && !pps) {
          let end = start + 1;
          for (; end < start + 100; end++) {
            if (u8[end] === 0 && u8[end+1] === 0 && ((u8[end+2] === 1) || (u8[end+2] === 0 && u8[end+3] === 1))) break;
          }
          pps = u8.subarray(start, end);
        }
      }
      if (sps && pps) break;
    }

    if (!sps || !pps) return null;

    const spsInfo = parseSpsInfo(sps);
    const avcc = createAvcC(sps, pps);

    // Group NALs into Access Units (AVCC chunks)
    const chunks = [];
    let curAuNals = [];
    let curAuKey = false;
    let curAuPts = 0;
    let firstVideoPts = null;

    function flushAu() {
      if (curAuNals.length === 0) return;
      let totalBytes = 0;
      for (const n of curAuNals) totalBytes += 4 + n.length;
      const auBuf = new Uint8Array(totalBytes);
      const view = new DataView(auBuf.buffer);
      let pos = 0;
      for (const n of curAuNals) {
        view.setUint32(pos, n.length, false); // 4-byte big-endian length
        auBuf.set(n, pos + 4);
        pos += 4 + n.length;
      }
      chunks.push({
        data: auBuf,
        isKey: curAuKey,
        pts: curAuPts
      });
      curAuNals = [];
      curAuKey = false;
    }

    for (let i = 0; i < pesList.length; i++) {
      let totalLen = 0;
      for (const c of pesList[i]) totalLen += c.length;
      const pesBuf = new Uint8Array(totalLen);
      let pos = 0;
      for (const c of pesList[i]) {
        pesBuf.set(c, pos);
        pos += c.length;
      }
      if (pesBuf[0] !== 0 || pesBuf[1] !== 0 || pesBuf[2] !== 1) continue;
      const flags2 = pesBuf[7];
      const ptsFlags = (flags2 & 0xc0) >> 6;
      const headerLen = pesBuf[8];
      let pts = null;
      if ((ptsFlags & 0x02) !== 0) {
        const b0 = pesBuf[9], b1 = pesBuf[10], b2 = pesBuf[11], b3 = pesBuf[12], b4 = pesBuf[13];
        pts = ((b0 & 0x0e) * 536870912) + ((b1 & 0xff) << 22) + ((b2 & 0xfe) << 14) + ((b3 & 0xff) << 7) + ((b4 & 0xfe) >> 1);
        if (firstVideoPts === null) firstVideoPts = pts;
      }
      const payload = pesBuf.subarray(9 + headerLen);

      let lastStart = -1, lastLen = 0;
      for (let j = 0; j < payload.length - 3; j++) {
        let scLen = 0;
        if (payload[j] === 0 && payload[j+1] === 0) {
          if (payload[j+2] === 1) scLen = 3;
          else if (payload[j+2] === 0 && payload[j+3] === 1) scLen = 4;
        }
        if (scLen > 0) {
          if (lastStart !== -1) {
            const nalRaw = payload.subarray(lastStart + lastLen, j);
            const nType = nalRaw[0] & 0x1f;
            if (nType === 9 && curAuNals.length > 0) flushAu();
            if (nType !== 7 && nType !== 8 && nType !== 9) {
              curAuNals.push(nalRaw);
              if (nType === 5) curAuKey = true;
              if (pts !== null) curAuPts = pts;
            }
          }
          lastStart = j;
          lastLen = scLen;
          j += scLen - 1;
        }
      }
      if (lastStart !== -1) {
        const nalRaw = payload.subarray(lastStart + lastLen);
        const nType = nalRaw[0] & 0x1f;
        if (nType !== 7 && nType !== 8 && nType !== 9) {
          curAuNals.push(nalRaw);
          if (nType === 5) curAuKey = true;
          if (pts !== null) curAuPts = pts;
        }
      }
    }
    flushAu();

    if (!chunks.length) return null;

    // Assemble AC-3 audio stream
    const ac3Chunks = [];
    let firstAudioPts = null;
    for (let i = 0; i < audioPesList.length; i++) {
      let totalLen = 0;
      for (const c of audioPesList[i]) totalLen += c.length;
      const pesBuf = new Uint8Array(totalLen);
      let pos = 0;
      for (const c of audioPesList[i]) {
        pesBuf.set(c, pos);
        pos += c.length;
      }
      if (pesBuf[0] !== 0 || pesBuf[1] !== 0 || pesBuf[2] !== 1) continue;
      const flags2 = pesBuf[7];
      const ptsFlags = (flags2 & 0xc0) >> 6;
      const headerLen = pesBuf[8];
      if ((ptsFlags & 0x02) !== 0 && firstAudioPts === null) {
        const b0 = pesBuf[9], b1 = pesBuf[10], b2 = pesBuf[11], b3 = pesBuf[12], b4 = pesBuf[13];
        firstAudioPts = ((b0 & 0x0e) * 536870912) + ((b1 & 0xff) << 22) + ((b2 & 0xfe) << 14) + ((b3 & 0xff) << 7) + ((b4 & 0xfe) >> 1);
      }
      const payloadStart = 9 + headerLen;
      for (let j = payloadStart; j < pesBuf.length - 1; j++) {
        if (pesBuf[j] === 0x0B && pesBuf[j+1] === 0x77) {
          ac3Chunks.push(pesBuf.subarray(j));
          break;
        }
      }
    }

    let rawAc3 = null;
    if (ac3Chunks.length > 0) {
      let totalAc3Bytes = 0;
      for (const c of ac3Chunks) totalAc3Bytes += c.length;
      rawAc3 = new Uint8Array(totalAc3Bytes);
      let wOff = 0;
      for (const c of ac3Chunks) {
        rawAc3.set(c, wOff);
        wOff += c.length;
      }
    }

    const audioOffsetUs = (firstAudioPts !== null && firstVideoPts !== null)
      ? Math.round(((firstAudioPts - firstVideoPts) * 1000000) / 90000)
      : 0;

    // Estimate duration from chunks
    const duration = chunks.length > 1
      ? Math.max(1, (chunks[chunks.length - 1].pts - chunks[0].pts) / 90000)
      : (chunks.length / 25);

    return {
      width: spsInfo.displayWidth || 1920,
      height: spsInfo.displayHeight || 1080,
      codedWidth: spsInfo.codedWidth,
      codedHeight: spsInfo.codedHeight,
      displayWidth: spsInfo.displayWidth,
      displayHeight: spsInfo.displayHeight,
      fps: 25,
      duration,
      codec: spsInfo.codec,
      description: avcc,
      chunks,
      rawAc3,
      audioOffsetUs
    };
  }

  /**
   * Downmix multi-channel (5.1 surround or mono) float32 audio to stereo.
   * Standard WAV order: FL(0), FR(1), FC(2), LFE(3), BL(4), BR(5).
   */
  function downmixToStereo(channels) {
    if (!channels || channels.length === 0) return [new Float32Array(0), new Float32Array(0)];
    if (channels.length === 1) return [channels[0], channels[0]];
    if (channels.length === 2) return [channels[0], channels[1]];
    const len = channels[0].length;
    const left = new Float32Array(len);
    const right = new Float32Array(len);
    const fl = channels[0], fr = channels[1];
    const fc = channels[2] || fl;
    const bl = channels[4] || fl;
    const br = channels[5] || fr;
    const cGain = 0.7071, sGain = 0.7071;
    for (let i = 0; i < len; i++) {
      const c = fc[i] * cGain;
      left[i] = Math.max(-1.0, Math.min(1.0, fl[i] + c + (bl[i] * sGain)));
      right[i] = Math.max(-1.0, Math.min(1.0, fr[i] + c + (br[i] * sGain)));
    }
    return [left, right];
  }

  /**
   * Direct MTS / M2TS Demuxing and WebCodecs Transcoding Pipeline (Video + AC-3 Audio)
   */
  async function transcodeMtsDirect(mtsBuffer, options, onProgress) {
    const parsed = parseMtsH264(mtsBuffer);
    if (!parsed || !parsed.chunks.length) {
      throw new Error('Failed to parse MTS/M2TS H.264 video stream');
    }

    const {
      targetResolution = '720p',
      targetFps = 15,
      rateControl = 'qualityFactor',
      qualityFactor = 'good',
      exactBitrate = 1500,
      targetSizeBytes = null,
      audioMode = 'copy',
      audioBitrate: requestedAudioBitrate = 128000
    } = options;

    const origW = parsed.displayWidth || 1920;
    const origH = parsed.displayHeight || 1080;
    const targetDim = calculateVideoDimensions(origW, origH, targetResolution);
    const outW = targetDim.width;
    const outH = targetDim.height;

    let effectiveFps = 15;
    if (typeof targetFps === 'number') effectiveFps = targetFps;
    else if (targetFps === '30') effectiveFps = 30;
    else if (targetFps === '24') effectiveFps = 24;
    else if (targetFps === '15') effectiveFps = 15;
    else if (targetFps === '10') effectiveFps = 10;
    else effectiveFps = 15;

    // Decode AC-3 Audio using liba52 WASM if available
    let decodedAudio = null;
    let stereoChannels = null;
    let hasAudio = false;
    const audioBitrate = Number(requestedAudioBitrate) || 128000;
    const DecodeAC3Lib = globalScope.DecodeAC3 || (typeof window !== 'undefined' ? window.DecodeAC3 : null);

    if (audioMode !== 'mute' && parsed.rawAc3 && DecodeAC3Lib && typeof AudioEncoder !== 'undefined') {
      try {
        if (onProgress) onProgress({ phase: 'decoding-audio', progress: 5 });
        decodedAudio = await DecodeAC3Lib.decode(parsed.rawAc3);
        if (decodedAudio && decodedAudio.channelData && decodedAudio.channelData.length > 0) {
          stereoChannels = downmixToStereo(decodedAudio.channelData);
          hasAudio = stereoChannels[0].length > 0;
        }
      } catch (aErr) {
        console.warn('[MTS] AC-3 audio decode error, falling back to video-only:', aErr);
        decodedAudio = null;
        stereoChannels = null;
        hasAudio = false;
      }
    }

    const videoBitrate = calculateTargetBitrate({
      width: outW,
      height: outH,
      fps: effectiveFps,
      duration: parsed.duration,
      rateControl,
      qualityFactor,
      exactBitrate,
      targetSizeBytes,
      audioBitrate: hasAudio ? audioBitrate : 0
    });

    const Mp4MuxerLib = globalScope.Mp4Muxer || window.Mp4Muxer;
    if (!Mp4MuxerLib) throw new Error('Mp4Muxer library not loaded');
    const muxerTarget = new Mp4MuxerLib.ArrayBufferTarget();
    const muxerOptions = {
      target: muxerTarget,
      video: {
        codec: 'avc',
        width: outW,
        height: outH
      },
      firstTimestampBehavior: 'offset',
      fastStart: 'in-memory'
    };

    let audioEncoder = null;
    let audioEncoderError = null;

    if (hasAudio && decodedAudio) {
      const aacConfig = {
        codec: 'mp4a.40.2',
        sampleRate: decodedAudio.sampleRate || 48000,
        numberOfChannels: 2,
        bitrate: audioBitrate
      };
      try {
        const sup = await AudioEncoder.isConfigSupported(aacConfig);
        if (sup && sup.supported) {
          audioEncoder = new AudioEncoder({
            output: (chunk, metadata) => muxer.addAudioChunk(chunk, metadata),
            error: (e) => { audioEncoderError = e; console.error('[MTS AudioEncoder Error]', e); }
          });
          await audioEncoder.configure(aacConfig);
          muxerOptions.audio = {
            codec: 'aac',
            numberOfChannels: 2,
            sampleRate: decodedAudio.sampleRate || 48000
          };
        }
      } catch (aeErr) {
        console.warn('[MTS] AudioEncoder configure failed, fallback to video-only:', aeErr);
        audioEncoder = null;
      }
    }

    const muxer = new Mp4MuxerLib.Muxer(muxerOptions);

    let encoderError = null;
    const encoder = new VideoEncoder({
      output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
      error: (e) => { encoderError = e; console.error('[MTS Encoder Error]', e); }
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
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    let encodedFrameCount = 0;
    let decodedFrameCount = 0;
    const minIntervalUs = Math.round(1000000 / effectiveFps);
    let lastEncodedTimestampUs = -minIntervalUs;

    let decoderError = null;
    const decoder = new VideoDecoder({
      output: (frame) => {
        decodedFrameCount++;
        if (frame.timestamp - lastEncodedTimestampUs >= minIntervalUs * 0.85) {
          ctx.drawImage(frame, 0, 0, outW, outH);
          const outTimestampUs = Math.round(encodedFrameCount * (1000000 / effectiveFps));
          const scaledFrame = new VideoFrame(canvas, {
            timestamp: outTimestampUs,
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
      error: (e) => { decoderError = e; console.error('[MTS Decoder Error]', e); }
    });

    await decoder.configure({
      codec: parsed.codec,
      description: parsed.description,
      hardwareAcceleration: 'no-preference'
    });

    const totalChunks = parsed.chunks.length;
    let lastTsUs = 0;

    for (let i = 0; i < totalChunks; i++) {
      if (encoderError) throw encoderError;
      if (decoderError) throw decoderError;

      const c = parsed.chunks[i];
      let tsUs = Math.round((c.pts * 1000000) / 90000);
      if (tsUs <= lastTsUs) tsUs = lastTsUs + 20000;
      lastTsUs = tsUs;

      const encChunk = new EncodedVideoChunk({
        type: c.isKey ? 'key' : 'delta',
        timestamp: tsUs,
        data: c.data
      });

      decoder.decode(encChunk);

      if (onProgress && i % 15 === 0) {
        onProgress({
          phase: 'processing',
          progress: Math.round((i / totalChunks) * 80),
          currentFrame: i,
          totalFrames: totalChunks
        });
      }
    }

    await decoder.flush();
    decoder.close();

    if (onProgress) onProgress({ phase: 'encoding-video', progress: 85 });

    await encoder.flush();
    encoder.close();

    // Encode audio if available
    if (audioEncoder && stereoChannels) {
      if (onProgress) onProgress({ phase: 'encoding-audio', progress: 90 });
      const [leftCh, rightCh] = stereoChannels;
      const sampleRate = decodedAudio.sampleRate || 48000;
      const totalSamples = leftCh.length;
      const CHUNK_SIZE = 1024;
      let startSample = 0;
      let initialTimestampUs = 0;

      if (parsed.audioOffsetUs < 0) {
        startSample = Math.min(totalSamples, Math.round((-parsed.audioOffsetUs * sampleRate) / 1000000));
      } else if (parsed.audioOffsetUs > 0) {
        initialTimestampUs = parsed.audioOffsetUs;
      }

      for (let s = startSample; s < totalSamples; s += CHUNK_SIZE) {
        if (audioEncoderError) throw audioEncoderError;
        const numFrames = Math.min(CHUNK_SIZE, totalSamples - s);
        const planar = new Float32Array(numFrames * 2);
        planar.set(leftCh.subarray(s, s + numFrames), 0);
        planar.set(rightCh.subarray(s, s + numFrames), numFrames);

        const sampleOffset = s - startSample;
        const timestampUs = initialTimestampUs + Math.round((sampleOffset * 1000000) / sampleRate);

        const aData = new AudioData({
          format: 'f32-planar',
          sampleRate: sampleRate,
          numberOfChannels: 2,
          numberOfFrames: numFrames,
          timestamp: timestampUs,
          data: planar
        });

        audioEncoder.encode(aData);
        aData.close();
      }

      await audioEncoder.flush();
      audioEncoder.close();
    }

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

      // Check if MPEG-TS / M2TS / MTS (192-byte BDAV or 188-byte TS)
      const u8Full = new Uint8Array(buffer);
      const isMts = (u8Full.length >= 196 && u8Full[4] === 0x47 && u8Full[4 + 192] === 0x47) ||
                    (u8Full.length >= 189 && u8Full[0] === 0x47 && u8Full[188] === 0x47) ||
                    (options.filename && /\.(mts|m2ts|ts)$/i.test(options.filename)) ||
                    (blob && blob.name && /\.(mts|m2ts|ts)$/i.test(blob.name));

      if (isMts) {
        return await transcodeMtsDirect(buffer, options, onProgress);
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
    parseMtsH264,
    transcodeMtsDirect,
    QUALITY_FACTORS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = VideoProcessor;
  } else {
    globalScope.VideoProcessor = VideoProcessor;
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this)));
