/**
 * audio-processor.js - Client-Side Audio Compression Engine
 * 
 * Compresses standalone audio files and embedded audio inside Office documents (.pptx, .docx).
 * Uses WebCodecs AudioEncoder, Web Audio API, Mp4Muxer, WebMMuxer, and bundled WASM AAC encoder.
 * Supports presets and custom configurations:
 * - Audio Mode: Transcode AAC (M4A), Transcode Opus (WebM), Pass-through, Mute
 * - Audio Bitrate: 64 kbps (Voice/Low), 96 kbps (Standard), 128 kbps (High), 160 kbps, 192 kbps
 * - Audio Channel: Original, Stereo (2 channels), Mono (1 channel)
 */

(function (globalScope) {
  'use strict';

  // Standard 2-byte AudioSpecificConfig for AAC-LC (ISO/IEC 14496-3)
  function getAacAudioSpecificConfig(sampleRate = 48000, channels = 2) {
    const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    let srIdx = sampleRates.indexOf(sampleRate);
    if (srIdx === -1) srIdx = 3; // 48000 default
    const byte0 = (2 << 3) | ((srIdx >> 1) & 0x07);
    const byte1 = ((srIdx & 0x01) << 7) | ((channels & 0x0f) << 3);
    return new Uint8Array([byte0, byte1]);
  }

  let _cachedAacModule = null;
  async function getAacEncoderModule() {
    if (_cachedAacModule) return _cachedAacModule;
    let factory = globalScope.AacEncoderWasm || (typeof window !== 'undefined' ? window.AacEncoderWasm : null);
    if (!factory && typeof window !== 'undefined' && window.DependencyLoader) {
      try {
        await window.DependencyLoader.load('aac-encoder');
      } catch (e) {
        console.warn('[AudioProcessor] DependencyLoader failed to load aac-encoder:', e);
      }
      factory = globalScope.AacEncoderWasm || window.AacEncoderWasm;
    }
    if (!factory) {
      throw new Error('AacEncoderWasm module is not available');
    }
    _cachedAacModule = await factory();
    return _cachedAacModule;
  }

  /**
   * Encodes Float32Array PCM audio using the bundled FFmpeg libavcodec AAC WASM encoder.
   * Produces compliant raw AAC access units with AudioSpecificConfig metadata and feeds them
   * directly to the active Mp4Muxer or WebMMuxer.
   */
  async function encodeAudioWithWasmAac({
    pcmChannels,
    numberOfChannels = 2,
    sampleRate = 48000,
    bitrate = 64000,
    muxer,
    finalContainer = 'm4a',
    onProgress = null
  }) {
    const mod = await getAacEncoderModule();
    const initEncoderFn = mod.cwrap('init_encoder', 'number', ['number', 'number', 'number']);
    const getEncoderFrameSize = mod.cwrap('get_encoder_frame_size', 'number', ['number']);
    const getEncoderExtradata = mod.cwrap('get_encoder_extradata', 'number', ['number']);
    const getEncoderExtradataSize = mod.cwrap('get_encoder_extradata_size', 'number', ['number']);
    const getEncodeInputPtr = mod.cwrap('get_encode_input_ptr', 'number', ['number', 'number']);
    const sendFrameFn = mod.cwrap('send_frame', 'number', ['number', 'number']);
    const receivePacketFn = mod.cwrap('receive_packet', 'number', ['number']);
    const flushEncoderStartFn = mod.cwrap('flush_encoder_start', null, ['number']);
    const getEncodedData = mod.cwrap('get_encoded_data', 'number', ['number']);
    const getEncodedDuration = mod.cwrap('get_encoded_duration', 'number', ['number']);
    const closeEncoderFn = mod.cwrap('close_encoder', null, ['number']);

    const channels = numberOfChannels;
    const ctx = initEncoderFn(channels, sampleRate, bitrate);
    if (!ctx) throw new Error('Failed to initialize WASM AAC encoder (ctx is 0)');

    try {
      const frameSize = getEncoderFrameSize(ctx); // 1024
      const extradataPtr = getEncoderExtradata(ctx);
      const extradataSize = getEncoderExtradataSize(ctx);
      const extradata = mod.HEAPU8.slice(extradataPtr, extradataPtr + extradataSize);

      const totalSamples = pcmChannels[0].length;
      const inputFloat32 = new Float32Array(frameSize * channels);
      const inputBytes = new Uint8Array(inputFloat32.buffer);

      let packetCount = 0;
      const meta = {
        decoderConfig: {
          codec: 'mp4a.40.2',
          sampleRate: sampleRate,
          numberOfChannels: channels,
          description: extradata
        }
      };

      const drainPackets = () => {
        let size;
        while ((size = receivePacketFn(ctx)) > 0) {
          const ptr = getEncodedData(ctx);
          const data = new Uint8Array(mod.HEAPU8.slice(ptr, ptr + size));
          const dur = getEncodedDuration(ctx) || frameSize;
          const timestampUs = Math.max(0, Math.round(((packetCount * frameSize) / sampleRate) * 1e6));
          const durationUs = Math.round((dur / sampleRate) * 1e6);

          if (finalContainer === 'webm' || finalContainer === 'mkv') {
            muxer.addAudioChunkRaw(data, 'key', timestampUs, meta);
          } else {
            muxer.addAudioChunkRaw(data, 'key', timestampUs, durationUs, meta);
          }
          packetCount++;
        }
      };

      let frameIndex = 0;
      for (let s = 0; s < totalSamples; s += frameSize) {
        const count = Math.min(frameSize, totalSamples - s);

        if (channels === 1) {
          const ch0 = pcmChannels[0];
          for (let i = 0; i < count; i++) {
            inputFloat32[i] = ch0[s + i];
          }
          for (let i = count; i < frameSize; i++) {
            inputFloat32[i] = 0;
          }
        } else {
          const ch0 = pcmChannels[0];
          const ch1 = pcmChannels[1];
          for (let i = 0; i < count; i++) {
            inputFloat32[i * 2] = ch0[s + i];
            inputFloat32[i * 2 + 1] = ch1[s + i];
          }
          for (let i = count; i < frameSize; i++) {
            inputFloat32[i * 2] = 0;
            inputFloat32[i * 2 + 1] = 0;
          }
        }

        const inputPtr = getEncodeInputPtr(ctx, inputBytes.length);
        mod.HEAPU8.set(inputBytes, inputPtr);

        const ret = sendFrameFn(ctx, BigInt(frameIndex * frameSize));
        if (ret < 0) {
          throw new Error('send_frame failed with code ' + ret);
        }
        drainPackets();
        frameIndex++;

        if (onProgress && totalSamples > 0 && frameIndex % 20 === 0) {
          const pct = Math.min(95, Math.round((s / totalSamples) * 100));
          onProgress({ progress: pct, phase: 'Encoding AAC (WASM)' });
        }
      }

      flushEncoderStartFn(ctx);
      drainPackets();
    } finally {
      closeEncoderFn(ctx);
    }
  }

  /**
   * Maps or downmixes PCM audio to target channel mode (mono, stereo, original).
   */
  function preparePcmChannels(audioBuffer, channelMode = 'stereo') {
    const origChannels = audioBuffer.numberOfChannels;
    const len = audioBuffer.length;
    const sampleRate = audioBuffer.sampleRate;

    let targetChannels = 2;
    if (channelMode === 'mono') {
      targetChannels = 1;
    } else if (channelMode === 'stereo') {
      targetChannels = 2;
    } else { // 'original'
      targetChannels = origChannels <= 2 ? origChannels : 2;
    }

    if (targetChannels === 1) {
      if (origChannels === 1) {
        return {
          channels: [audioBuffer.getChannelData(0)],
          numberOfChannels: 1,
          sampleRate,
          length: len
        };
      }
      const mono = new Float32Array(len);
      if (origChannels === 2) {
        const ch0 = audioBuffer.getChannelData(0);
        const ch1 = audioBuffer.getChannelData(1);
        for (let i = 0; i < len; i++) {
          mono[i] = 0.5 * (ch0[i] + ch1[i]);
        }
      } else {
        const scale = 1.0 / origChannels;
        for (let ch = 0; ch < origChannels; ch++) {
          const data = audioBuffer.getChannelData(ch);
          for (let i = 0; i < len; i++) {
            mono[i] += data[i] * scale;
          }
        }
      }
      return {
        channels: [mono],
        numberOfChannels: 1,
        sampleRate,
        length: len
      };
    } else {
      // targetChannels === 2
      if (origChannels === 2) {
        return {
          channels: [audioBuffer.getChannelData(0), audioBuffer.getChannelData(1)],
          numberOfChannels: 2,
          sampleRate,
          length: len
        };
      }
      if (origChannels === 1) {
        const ch0 = audioBuffer.getChannelData(0);
        return {
          channels: [ch0, ch0],
          numberOfChannels: 2,
          sampleRate,
          length: len
        };
      }
      // Multi-channel (e.g. 5.1 surround) ITU downmix to stereo
      const left = new Float32Array(len);
      const right = new Float32Array(len);
      const fl = audioBuffer.getChannelData(0);
      const fr = audioBuffer.getChannelData(1);
      const fc = origChannels > 2 ? audioBuffer.getChannelData(2) : fl;
      const bl = origChannels > 4 ? audioBuffer.getChannelData(4) : fl;
      const br = origChannels > 5 ? audioBuffer.getChannelData(5) : fr;
      const cGain = 0.7071, sGain = 0.7071;
      for (let i = 0; i < len; i++) {
        const c = fc[i] * cGain;
        left[i] = Math.max(-1.0, Math.min(1.0, fl[i] + c + (bl[i] * sGain)));
        right[i] = Math.max(-1.0, Math.min(1.0, fr[i] + c + (br[i] * sGain)));
      }
      return {
        channels: [left, right],
        numberOfChannels: 2,
        sampleRate,
        length: len
      };
    }
  }

  /**
   * Main Audio Compression Entry Point
   * 
   * @param {File|Blob|ArrayBuffer|Uint8Array} input - Input audio file or data
   * @param {Object} options - Audio compression parameters
   * @param {Function} [onProgress] - Progress callback ({ progress, phase })
   * @returns {Promise<{ buffer: ArrayBuffer, blob: Blob, mime: string, container: string }>}
   */
  async function compressAudio(input, options = {}, onProgress = null) {
    if (onProgress) onProgress({ progress: 5, phase: 'Reading audio' });

    // 1. Normalize input to ArrayBuffer
    let arrayBuffer;
    if (input instanceof ArrayBuffer) {
      arrayBuffer = input;
    } else if (ArrayBuffer.isView(input)) {
      arrayBuffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    } else if (input instanceof Blob) {
      arrayBuffer = await input.arrayBuffer();
    } else {
      throw new Error('Unsupported audio input type');
    }

    const audioMode = options.audioMode || 'aac';
    const audioBitrate = Number(options.audioBitrate) || 96000;
    const audioChannels = options.audioChannels || 'stereo';

    // Fast-path: Passthrough mode
    if (audioMode === 'passthrough') {
      const mime = options.mime || 'audio/mp4';
      const container = mime.includes('webm') ? 'webm' : 'm4a';
      return {
        buffer: arrayBuffer,
        blob: new Blob([arrayBuffer], { type: mime }),
        mime,
        container
      };
    }

    // Fast-path: Mute mode (generate 1 second of silence)
    if (audioMode === 'mute') {
      const silentBuffer = new ArrayBuffer(0);
      return {
        buffer: silentBuffer,
        blob: new Blob([silentBuffer], { type: 'audio/mp4' }),
        mime: 'audio/mp4',
        container: 'm4a'
      };
    }

    if (onProgress) onProgress({ progress: 15, phase: 'Decoding audio' });

    // 2. Decode PCM via Web Audio API AudioContext
    const AudioContextClass = globalScope.AudioContext || globalScope.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error('Web Audio API AudioContext is not supported in this environment');
    }

    const audioCtx = new AudioContextClass();
    let audioBuffer;
    try {
      audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    } catch (decodeErr) {
      // Check if raw AC-3 decoder is available as fallback
      const DecodeAC3Lib = globalScope.DecodeAC3 || (typeof window !== 'undefined' ? window.DecodeAC3 : null);
      if (DecodeAC3Lib && typeof DecodeAC3Lib.decodeAC3 === 'function') {
        try {
          const ac3Result = DecodeAC3Lib.decodeAC3(new Uint8Array(arrayBuffer));
          if (ac3Result && ac3Result.channels && ac3Result.channels.length > 0) {
            audioBuffer = {
              numberOfChannels: ac3Result.channels.length,
              sampleRate: ac3Result.sampleRate || 48000,
              length: ac3Result.channels[0].length,
              duration: ac3Result.channels[0].length / (ac3Result.sampleRate || 48000),
              getChannelData: (ch) => ac3Result.channels[ch]
            };
          }
        } catch (ac3Err) {
          throw new Error('Audio decoding failed: ' + (decodeErr.message || decodeErr));
        }
      } else {
        throw new Error('Audio decoding failed: ' + (decodeErr.message || decodeErr));
      }
    } finally {
      if (audioCtx.state !== 'closed') {
        audioCtx.close().catch(() => {});
      }
    }

    if (onProgress) onProgress({ progress: 30, phase: 'Mixing channels' });

    // 3. Prepare target PCM channels according to Audio Channel setting
    const { channels: pcmChannels, numberOfChannels: targetChannels, sampleRate } = preparePcmChannels(audioBuffer, audioChannels);

    // 4. Determine output container and codec
    const finalContainer = (audioMode === 'opus') ? 'webm' : 'm4a';
    const finalMime = finalContainer === 'webm' ? 'audio/webm' : 'audio/mp4';

    if (onProgress) onProgress({ progress: 40, phase: 'Configuring encoder' });

    // 5. Initialize Muxer
    let muxer;
    if (finalContainer === 'webm') {
      const WebMMuxer = globalScope.WebMMuxer || window.WebMMuxer;
      if (!WebMMuxer) throw new Error('WebMMuxer library is not available');
      muxer = new WebMMuxer.Muxer({
        target: new WebMMuxer.ArrayBufferTarget(),
        audio: {
          codec: 'V_OPUS',
          sampleRate: sampleRate,
          numberOfChannels: targetChannels
        }
      });
    } else {
      const Mp4Muxer = globalScope.Mp4Muxer || window.Mp4Muxer;
      if (!Mp4Muxer) throw new Error('Mp4Muxer library is not available');
      muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        audio: {
          codec: 'aac',
          sampleRate: sampleRate,
          numberOfChannels: targetChannels
        },
        fastStart: 'in-memory'
      });
    }

    // 6. Encode Audio Chunks
    if (finalContainer === 'webm') {
      // Opus Encoding via WebCodecs AudioEncoder
      if (typeof AudioEncoder === 'undefined') {
        throw new Error('WebCodecs AudioEncoder is required for Opus encoding');
      }

      let audioEncoderError = null;
      const audioEncoder = new AudioEncoder({
        output: (chunk, metadata) => {
          muxer.addAudioChunk(chunk, metadata);
        },
        error: (e) => {
          audioEncoderError = e;
          console.error('[AudioProcessor] AudioEncoder error:', e);
        }
      });

      await audioEncoder.configure({
        codec: 'opus',
        sampleRate: sampleRate,
        numberOfChannels: targetChannels,
        bitrate: audioBitrate
      });

      const frameSize = 960; // 20ms at 48000Hz standard Opus packet size
      const totalFrames = pcmChannels[0].length;
      let s = 0;

      while (s < totalFrames) {
        if (audioEncoderError) throw audioEncoderError;
        const count = Math.min(frameSize, totalFrames - s);
        const planar = new Float32Array(count * targetChannels);
        for (let ch = 0; ch < targetChannels; ch++) {
          planar.set(pcmChannels[ch].subarray(s, s + count), ch * count);
        }

        const timestampUs = Math.round((s / sampleRate) * 1e6);
        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate: sampleRate,
          numberOfFrames: count,
          numberOfChannels: targetChannels,
          timestamp: timestampUs,
          data: planar
        });

        audioEncoder.encode(audioData);
        audioData.close();
        s += count;

        if (onProgress && totalFrames > 0 && (s % (frameSize * 20) === 0)) {
          const pct = Math.min(95, Math.round((s / totalFrames) * 60) + 35);
          onProgress({ progress: pct, phase: 'Encoding Opus' });
        }
      }

      await audioEncoder.flush();
      audioEncoder.close();
    } else {
      // AAC Encoding: Check native AudioEncoder support first, fallback to WASM AAC encoder
      let useNativeAac = false;
      if (typeof AudioEncoder !== 'undefined') {
        try {
          const support = await AudioEncoder.isConfigSupported({
            codec: 'mp4a.40.2',
            sampleRate: sampleRate,
            numberOfChannels: targetChannels,
            bitrate: audioBitrate
          });
          useNativeAac = !!support.supported;
        } catch (e) {
          useNativeAac = false;
        }
      }

      if (useNativeAac) {
        try {
          console.log(`[AudioProcessor] Using native WebCodecs AudioEncoder for AAC (${audioBitrate} bps, ${targetChannels} ch).`);
          const aacDesc = getAacAudioSpecificConfig(sampleRate, targetChannels);
          let audioEncoderError = null;

          const audioEncoder = new AudioEncoder({
            output: (chunk, metadata) => {
              if (!metadata || !metadata.decoderConfig || !metadata.decoderConfig.description) {
                metadata = metadata || {};
                metadata.decoderConfig = metadata.decoderConfig || {};
                metadata.decoderConfig.description = aacDesc;
              }
              muxer.addAudioChunk(chunk, metadata);
            },
            error: (e) => {
              audioEncoderError = e;
              console.error('[AudioProcessor] AudioEncoder error:', e);
            }
          });

          await audioEncoder.configure({
            codec: 'mp4a.40.2',
            sampleRate: sampleRate,
            numberOfChannels: targetChannels,
            bitrate: audioBitrate
          });

          const frameSize = 1024; // AAC frame size
          const totalFrames = pcmChannels[0].length;
          let s = 0;

          while (s < totalFrames) {
            if (audioEncoderError) throw audioEncoderError;
            const count = Math.min(frameSize, totalFrames - s);
            const planar = new Float32Array(count * targetChannels);
            for (let ch = 0; ch < targetChannels; ch++) {
              planar.set(pcmChannels[ch].subarray(s, s + count), ch * count);
            }

            const timestampUs = Math.round((s / sampleRate) * 1e6);
            const audioData = new AudioData({
              format: 'f32-planar',
              sampleRate: sampleRate,
              numberOfFrames: count,
              numberOfChannels: targetChannels,
              timestamp: timestampUs,
              data: planar
            });

            audioEncoder.encode(audioData);
            audioData.close();
            s += count;

            if (onProgress && totalFrames > 0 && (s % (frameSize * 20) === 0)) {
              const pct = Math.min(95, Math.round((s / totalFrames) * 60) + 35);
              onProgress({ progress: pct, phase: 'Encoding AAC' });
            }
          }

          await audioEncoder.flush();
          audioEncoder.close();
        } catch (nativeErr) {
          console.warn('[AudioProcessor] Native AudioEncoder failed, falling back to WASM AAC encoder:', nativeErr);
          useNativeAac = false;
        }
      }

      if (!useNativeAac) {
        console.log(`[AudioProcessor] Using bundled WASM AAC encoder (${audioBitrate} bps, ${targetChannels} ch).`);
        await encodeAudioWithWasmAac({
          pcmChannels,
          numberOfChannels: targetChannels,
          sampleRate,
          bitrate: audioBitrate,
          muxer,
          finalContainer: 'm4a',
          onProgress
        });
      }
    }

    if (onProgress) onProgress({ progress: 95, phase: 'Finalizing audio container' });

    // 7. Finalize container
    muxer.finalize();
    const outputBuffer = muxer.target.buffer;
    const outputBlob = new Blob([outputBuffer], { type: finalMime });

    if (onProgress) onProgress({ progress: 100, phase: 'Completed' });

    return {
      buffer: outputBuffer,
      blob: outputBlob,
      mime: finalMime,
      container: finalContainer
    };
  }

  // Export to global scope
  globalScope.AudioProcessor = {
    compressAudio,
    preparePcmChannels,
    getAacAudioSpecificConfig,
    getAacEncoderModule,
    encodeAudioWithWasmAac
  };

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
