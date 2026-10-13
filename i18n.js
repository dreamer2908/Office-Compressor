/**
 * i18n.js - Zero-Dependency Internationalization & Translation Engine
 * 
 * Supports English (en), Simplified Chinese (zh-CN), Traditional Chinese (zh-TW), and Vietnamese (vi).
 * Works 100% offline and under direct file execution (file:///) with no network requests or external dependencies.
 * Engine implementation is lightweight (< 100 lines of functional code).
 */

(function (globalScope) {
  'use strict';

  const TRANSLATIONS = {
    en: {
      header: {
        brand_title: 'Office Compressor',
        brand_subtitle: 'Zero-Install Client-Side Optimizer',
        libs_ready: '{loaded}/{total} Libs Ready',
        libs_ready_no_video: '{loaded}/{total} Ready • No Video Enc',
        libs_tooltip: 'All compression dependencies loaded',
        theme_light: '☀️ Light',
        theme_dark: '🌙 Dark',
        theme_toggle_aria: 'Toggle theme',
        lang_select_aria: 'Select language'
      },
      webcodecs_warning: {
        title: 'Video Encoding Disabled (WebCodecs Unavailable)',
        reason_unsecure: 'WebCodecs is unavailable because this page is served over an <strong>unsecure HTTP connection</strong>. Standalone videos will be skipped and embedded document videos will remain intact. Access via <strong>HTTPS</strong> or <strong>localhost</strong> to enable video compression.',
        reason_unsupported: 'WebCodecs (VideoEncoder) is not supported by your current browser. Video encoding is disabled; standalone videos will be skipped and embedded document videos will remain intact. Use a modern browser (Edge, Chrome, or Firefox).'
      },
      hero: {
        title_html: 'Compress Documents, Images & Videos <span class="hero-highlight">Privately</span>',
        desc: '100% browser-based compression. All processing runs in memory on your device with no server uploads. Shrink files effortlessly to fit email limits.'
      },
      presets: {
        title: 'Select Compression Preset',
        email_strict: {
          badge: '< 10 MB',
          title: 'Email Strict',
          desc: 'Maximum reduction for strict enterprise mailboxes (Exchange / Outlook limits).',
          spec_video: '🎬 Video: 480p @ 15fps, Low Bitrate (0.05), AAC 64k',
          spec_audio: '🎵 Audio: AAC 64k Stereo',
          spec_img_doc: '🖼️ Images/Docs: 720p Max, Q: 60'
        },
        email_standard: {
          badge: '< 25 MB',
          title: 'Email Standard',
          desc: 'Recommended balance of quality and size for standard email attachments (Gmail / Outlook).',
          spec_video: '🎬 Video: 720p @ 15fps, Good Bitrate (0.08), AAC 96k',
          spec_audio: '🎵 Audio: AAC 96k Stereo',
          spec_img_doc: '🖼️ Images/Docs: 1080p Max, Q: 75'
        },
        screen_presentation: {
          badge: 'High Fidelity',
          title: 'Screen Presentation',
          desc: 'Crisp visuals for slide decks, projector displays, and UI screenshots.',
          spec_video: '🎬 Video: 1080p @ Original fps, High Bitrate (0.10)',
          spec_audio: '🎵 Audio: AAC 128k Original',
          spec_img_doc: '🖼️ Images/Docs: 1080p Max, Q: 85 (PNG for charts)'
        },
        custom: {
          badge: 'Advanced',
          title: 'Custom Mode',
          desc: 'Full manual control over codecs, resolutions, framerates, and quality settings.',
          spec_codecs: '🔧 VideoCodecs: AVC, HEVC, VP9, AV1',
          spec_images: '🎨 Images: WebP, JPEG, PNG with slider'
        }
      },
      custom_controls: {
        video_title: 'Video Compression Options',
        res_cap: 'Resolution Cap',
        res_original: 'Original Dimensions',
        res_1080p: '1080p (1920 × 1080)',
        res_720p: '720p (1280 × 720)',
        res_480p: '480p (854 × 480)',
        framerate: 'Framerate',
        fps_original: 'Original Framerate',
        fps_30: '30 fps',
        fps_24: '24 fps',
        fps_15: '15 fps (Recommended)',
        fps_10: '10 fps',
        rate_control: 'Rate Control Mode',
        rc_quality_factor: 'Dynamic Quality Factor',
        rc_bitrate: 'Target Bitrate (kbps)',
        rc_target_size: 'Target File Size (MB)',
        quality_factor: 'Quality Factor',
        qf_low: 'Low (0.05) - Compact',
        qf_good: 'Good (0.08) - Balanced',
        qf_high: 'High (0.10) - Presentation',
        qf_very_high: 'Very High (0.15) - Archival',
        exact_bitrate: 'Video Bitrate (kbps)',
        target_size: 'Target Size (MB)',
        hardware_codec: 'Hardware Codec',
        codec_auto: 'Auto (Highest Supported Profile)',
        codec_detecting: 'Auto (Detecting support...)',
        codec_disabled: 'Video encoding disabled (WebCodecs unavailable)',
        audio_mode: 'Audio Mode',
        audio_aac: 'Transcode AAC',
        audio_opus: 'Transcode Opus',
        audio_passthrough: 'Pass-through Raw',
        audio_mute: 'Mute Audio',
        audio_bitrate: 'Audio Bitrate',
        audio_bitrate_32k: '32 kbps (Ultra Low)',
        audio_bitrate_48k: '48 kbps (Voice / Low)',
        audio_bitrate_64k: '64 kbps (Modest)',
        audio_bitrate_96k: '96 kbps (Standard)',
        audio_bitrate_128k: '128 kbps (High Fidelity)',
        audio_bitrate_160k: '160 kbps (Studio)',
        audio_bitrate_192k: '192 kbps (Maximum)',
        audio_channel: 'Audio Channel',
        channel_original: 'Keep Original',
        channel_stereo: 'Stereo (2 Channels)',
        channel_mono: 'Mono (1 Channel)',
        container: 'Output Container',
        container_mp4: 'MP4 Container (.mp4)',
        container_mkv: 'Matroska / WebM (.mkv)',
        img_title: 'Standalone & Embedded Image Options',
        img_format: 'Output Format',
        img_format_auto: 'Auto-detect (PNG for UI, WebP for Photos)',
        img_format_webp: 'WebP (High Compression)',
        img_format_jpeg: 'JPEG (Standard Photography)',
        img_format_png: 'PNG (Lossless / Diagrams)',
        img_quality: 'Compression Quality',
        img_res: 'Max Bounding Box',
        img_res_original: 'Original Dimensions',
        img_res_1080p: '1080p (Max 1920 × 1080)',
        img_res_720p: '720p (Max 1280 × 720)',
        img_res_480p: '480p (Max 854 × 480)',
        note_doc_img: 'ℹ️ Embedded document images strictly enforce JPEG/PNG for backward compatibility.',
        note_doc_video: 'ℹ️ Embedded doc videos always transcode to AVC + AAC in MP4 container.'
      },
      dropzone: {
        heading: 'Drop Files or Folders Here',
        subtext: 'or click to browse from your computer',
        format_word: 'Word (.docx, .doc)',
        format_ppt: 'PowerPoint (.pptx, .ppt)',
        format_excel: 'Excel (.xlsx, .xls)',
        format_pdf: 'PDF (.pdf)',
        format_videos: 'Videos (.mp4, .mov, .avi, .mkv, .webm, .mts, .m2ts)',
        format_audios: 'Audios (.m4a, .mp3, .wav, .aac, .ogg, .flac)',
        format_images: 'Images (.jpg, .png, .webp, .tiff, .bmp, .gif)'
      },
      queue: {
        batch_progress: 'Batch Progress',
        status: 'Status',
        space_savings: 'Space Savings',
        files_completed: '{completed}/{total} files completed',
        saved_amount: 'Saved: {amount} (-{pct}%)',
        saved_zero: 'Saved: 0 B',
        btn_start: '⚡ Start Compression',
        btn_download_zip: '📦 Download All (ZIP)',
        btn_compressing_zip: '⏳ Compressing ZIP...',
        btn_clear: '✕ Clear',
        th_name: 'File Name',
        th_type: 'Type',
        th_orig_size: 'Original Size',
        th_comp_size: 'Compressed Size',
        th_space_saved: 'Space Saved',
        th_status: 'Status',
        th_actions: 'Actions'
      },
      status: {
        queued: 'Queued',
        completed: '✓ Completed',
        skipped: '⚠️ Skipped',
        error: '⚠️ Error',
        intact: 'Intact (0%)'
      },
      actions: {
        save: '💾 Save',
        preview: '🔍 Preview',
        remove: '✕'
      },
      modal: {
        visual_comparison: 'Visual Comparison',
        comparison_title: 'Comparison: {name}',
        orig_file: 'Original File',
        comp_output: 'Compressed Output',
        close_aria: 'Close modal'
      },
      phases: {
        ready: 'Ready',
        starting: 'Starting',
        analyzing_compressing: 'Analyzing & Compressing',
        transcoding_video: 'Transcoding Video',
        compressing_audio: 'Compressing Audio',
        processing_doc: 'Processing Document Media',
        encoding: 'Encoding',
        completed: 'Completed',
        failed: 'Failed',
        skipped_no_webcodecs: 'Skipped (No WebCodecs)',
        doc_video_intact: 'Completed (Embedded video kept intact)',
        loading_engine: 'Loading libav engine',
        packaging: 'Packaging Document',
        downsampling_pdf_images: 'Downsampling PDF Images',
        saving_pdf: 'Saving PDF',
        processing_media: 'Processing Document Media'
      }
    },

    'zh-CN': {
      header: {
        brand_title: 'Office Compressor',
        brand_subtitle: '免安装客户端本地优化工具',
        libs_ready: '{loaded}/{total} 依赖项就绪',
        libs_ready_no_video: '{loaded}/{total} 就绪 • 视频编码已停用',
        libs_tooltip: '所有压缩依赖项均已加载完毕',
        theme_light: '☀️ 浅色',
        theme_dark: '🌙 深色',
        theme_toggle_aria: '切换颜色主题',
        lang_select_aria: '选择显示语言'
      },
      webcodecs_warning: {
        title: '视频编码已停用（WebCodecs 不可用）',
        reason_unsecure: 'WebCodecs 不可用，因为此页面通过不安全的 <strong>HTTP 连接</strong>（非 localhost）提供服务。独立视频将被跳过，文档内嵌视频将保持原样。请通过 <strong>HTTPS</strong> 或 <strong>localhost</strong> 访问以启用视频压缩。',
        reason_unsupported: '当前浏览器不支持 WebCodecs (VideoEncoder)。视频编码已停用；独立视频将被跳过，文档内嵌视频将保持原样。请使用现代浏览器（Edge、Chrome 或 Firefox）。'
      },
      hero: {
        title_html: '私密安全压缩文档、图像与视频 <span class="hero-highlight">无须上传</span>',
        desc: '100% 浏览器本地运算压缩。所有数据仅在您设备的内存中处理，绝无服务器上传。轻松缩减文件体积，顺畅满足邮件发送限制。'
      },
      presets: {
        title: '选择压缩预设',
        email_strict: {
          badge: '< 10 MB',
          title: '严格邮件限制',
          desc: '针对严格的企业邮箱限制（Exchange / Outlook 10MB 上限）进行极致压缩。',
          spec_video: '🎬 视频: 480p @ 15fps, 低码率 (0.05), AAC 64k',
          spec_audio: '🎵 音频: AAC 64k 立体声',
          spec_img_doc: '🖼️ 图片/文档: 720p 上限, 质量: 60'
        },
        email_standard: {
          badge: '< 25 MB',
          title: '标准邮件推荐',
          desc: '兼顾画质与文件体积的推荐平衡方案（适用于 Gmail / Outlook 25MB 上限）。',
          spec_video: '🎬 视频: 720p @ 15fps, 均衡码率 (0.08), AAC 96k',
          spec_audio: '🎵 音频: AAC 96k 立体声',
          spec_img_doc: '🖼️ 图片/文档: 1080p 上限, 质量: 75'
        },
        screen_presentation: {
          badge: '高保真画质',
          title: '屏幕演示展示',
          desc: '专为幻灯片、投影演示和高清晰度界面截图优化的高清画质。',
          spec_video: '🎬 视频: 1080p @ 原始帧率, 高码率 (0.10)',
          spec_audio: '🎵 音频: AAC 128k 保持原始',
          spec_img_doc: '🖼️ 图片/文档: 1080p 上限, 质量: 85 (图表采用PNG)'
        },
        custom: {
          badge: '高级配置',
          title: '自定义模式',
          desc: '手动全面控制编解码器、分辨率、帧率及质量参数。',
          spec_codecs: '🔧 视频编码: AVC, HEVC, VP9, AV1',
          spec_images: '🎨 图片: 支持 WebP, JPEG, PNG 滑块调节'
        }
      },
      custom_controls: {
        video_title: '视频压缩选项',
        res_cap: '分辨率上限',
        res_original: '原始尺寸',
        res_1080p: '1080p (1920 × 1080)',
        res_720p: '720p (1280 × 720)',
        res_480p: '480p (854 × 480)',
        framerate: '帧率',
        fps_original: '原始帧率',
        fps_30: '30 fps',
        fps_24: '24 fps',
        fps_15: '15 fps (推荐)',
        fps_10: '10 fps',
        rate_control: '码率控制模式',
        rc_quality_factor: '动态质量系数',
        rc_bitrate: '目标码率 (kbps)',
        rc_target_size: '目标文件大小 (MB)',
        quality_factor: '质量系数',
        qf_low: '低 (0.05) - 极小体积',
        qf_good: '良好 (0.08) - 均衡',
        qf_high: '高 (0.10) - 演示级',
        qf_very_high: '极高 (0.15) - 归档级',
        exact_bitrate: '视频码率 (kbps)',
        target_size: '目标大小 (MB)',
        hardware_codec: '硬件编解码器',
        codec_auto: '自动 (最高支持配置)',
        codec_detecting: '自动 (正在检测支持...)',
        codec_disabled: '视频编码已禁用 (WebCodecs不可用)',
        audio_mode: '音频模式',
        audio_aac: '转码为 AAC',
        audio_opus: '转码为 Opus',
        audio_passthrough: '透传原始音频',
        audio_mute: '静音 (无音频)',
        audio_bitrate: '音频码率',
        audio_bitrate_32k: '32 kbps (极低)',
        audio_bitrate_48k: '48 kbps (语音/低)',
        audio_bitrate_64k: '64 kbps (适中)',
        audio_bitrate_96k: '96 kbps (标准)',
        audio_bitrate_128k: '128 kbps (高保真)',
        audio_bitrate_160k: '160 kbps (录音室)',
        audio_bitrate_192k: '192 kbps (最高)',
        audio_channel: '音频声道',
        channel_original: '保持原始',
        channel_stereo: '立体声 (双声道)',
        channel_mono: '单声道 (1 声道)',
        container: '封装格式',
        container_mp4: 'MP4 容器 (.mp4)',
        container_mkv: 'Matroska / WebM (.mkv)',
        img_title: '独立与嵌入式图片选项',
        img_format: '输出格式',
        img_format_auto: '自动检测 (界面图PNG, 照片WebP)',
        img_format_webp: 'WebP (高压缩率)',
        img_format_jpeg: 'JPEG (标准照片)',
        img_format_png: 'PNG (无损/图表)',
        img_quality: '压缩质量',
        img_res: '最大边界限制',
        img_res_original: '原始尺寸',
        img_res_1080p: '1080p (最大 1920 × 1080)',
        img_res_720p: '720p (最大 1280 × 720)',
        img_res_480p: '480p (最大 854 × 480)',
        note_doc_img: 'ℹ️ 文档嵌入图片为确保向下兼容，强制采用 JPEG/PNG。',
        note_doc_video: 'ℹ️ 文档嵌入视频一律转码为 MP4 容器下的 AVC + AAC。'
      },
      dropzone: {
        heading: '拖放文件或文件夹至此处',
        subtext: '或点击从您的电脑中浏览选取',
        format_word: 'Word (.docx, .doc)',
        format_ppt: 'PowerPoint (.pptx, .ppt)',
        format_excel: 'Excel (.xlsx, .xls)',
        format_pdf: 'PDF (.pdf)',
        format_videos: '视频 (.mp4, .mov, .avi, .mkv, .webm, .mts, .m2ts)',
        format_audios: '音频 (.m4a, .mp3, .wav, .aac, .ogg, .flac)',
        format_images: '图像 (.jpg, .png, .webp, .tiff, .bmp, .gif)'
      },
      queue: {
        batch_progress: '批处理进度',
        status: '状态',
        space_savings: '已节省空间',
        files_completed: '已完成 {completed}/{total} 个文件',
        saved_amount: '已节省: {amount} (-{pct}%)',
        saved_zero: '已节省: 0 B',
        btn_start: '⚡ 开始压缩',
        btn_download_zip: '📦 全部下载 (ZIP)',
        btn_compressing_zip: '⏳ 正在打包 ZIP...',
        btn_clear: '✕ 清空队列',
        th_name: '文件名',
        th_type: '类型',
        th_orig_size: '原始大小',
        th_comp_size: '压缩后大小',
        th_space_saved: '节省空间',
        th_status: '状态',
        th_actions: '操作'
      },
      status: {
        queued: '排队中',
        completed: '✓ 已完成',
        skipped: '⚠️ 已跳过',
        error: '⚠️ 错误',
        intact: '保持原样 (0%)'
      },
      actions: {
        save: '💾 保存',
        preview: '🔍 预览',
        remove: '✕'
      },
      modal: {
        visual_comparison: '效果视觉对比',
        comparison_title: '对比: {name}',
        orig_file: '原始文件',
        comp_output: '压缩后输出',
        close_aria: '关闭窗口'
      },
      phases: {
        ready: '就绪',
        starting: '正在启动',
        analyzing_compressing: '正在分析与压缩',
        transcoding_video: '正在转码视频',
        compressing_audio: '正在压缩音频',
        processing_doc: '正在处理文档媒体',
        encoding: '正在编码',
        completed: '已完成',
        failed: '失败',
        skipped_no_webcodecs: '已跳过（无 WebCodecs）',
        doc_video_intact: '已完成（嵌入视频保持原样）',
        loading_engine: '正在加载 libav 引擎',
        packaging: '正在重新打包文档',
        downsampling_pdf_images: '正在压缩 PDF 图片',
        saving_pdf: '正在生成 PDF',
        processing_media: '正在处理文档媒体'
      }
    },

    'zh-TW': {
      header: {
        brand_title: 'Office Compressor',
        brand_subtitle: '零安裝客戶端本機最佳化工具',
        libs_ready: '{loaded}/{total} 項相依元件就緒',
        libs_ready_no_video: '{loaded}/{total} 就緒 • 影片編碼已停用',
        libs_tooltip: '所有壓縮相依元件皆已載入完成',
        theme_light: '☀️ 淺色',
        theme_dark: '🌙 深色',
        theme_toggle_aria: '切換佈景主題',
        lang_select_aria: '選擇顯示語言'
      },
      webcodecs_warning: {
        title: '影片編碼已停用（WebCodecs 無法使用）',
        reason_unsecure: 'WebCodecs 無法使用，因為此頁面透過不安全的 <strong>HTTP 連線</strong>（非 localhost）提供服務。獨立影片將被略過，文件內嵌影片將保持原樣。請透過 <strong>HTTPS</strong> 或 <strong>localhost</strong> 存取以啟用影片壓縮。',
        reason_unsupported: '目前的瀏覽器不支援 WebCodecs (VideoEncoder)。影片編碼已停用；獨立影片將被略過，文件內嵌影片將保持原樣。請使用現代瀏覽器（Edge、Chrome 或 Firefox）。'
      },
      hero: {
        title_html: '私密安全壓縮文件、圖片與影片 <span class="hero-highlight">絕無上傳</span>',
        desc: '100% 瀏覽器本機運算壓縮。所有程序皆於您裝置的記憶體中執行，絕無伺服器上傳。輕鬆縮減檔案大小，符合電子郵件容量限制。'
      },
      presets: {
        title: '選擇壓縮預設組',
        email_strict: {
          badge: '< 10 MB',
          title: '嚴格郵件限制',
          desc: '針對嚴格的企業信箱上限（Exchange / Outlook 10MB 上限）進行極致壓縮。',
          spec_video: '🎬 影片: 480p @ 15fps, 低位元率 (0.05), AAC 64k',
          spec_audio: '🎵 音訊: AAC 64k 雙聲道',
          spec_img_doc: '🖼️ 圖片/文件: 720p 上限, 品質: 60'
        },
        email_standard: {
          badge: '< 25 MB',
          title: '標準郵件推薦',
          desc: '兼顧畫質與檔案大小的建議平衡配置（適用於 Gmail / Outlook 25MB 上限）。',
          spec_video: '🎬 影片: 720p @ 15fps, 良好位元率 (0.08), AAC 96k',
          spec_audio: '🎵 音訊: AAC 96k 雙聲道',
          spec_img_doc: '🖼️ 圖片/文件: 1080p 上限, 品質: 75'
        },
        screen_presentation: {
          badge: '高傳真畫質',
          title: '螢幕簡報展示',
          desc: '專為簡報投影片、投影機展示及清晰介面截圖最佳化的高傳真畫質。',
          spec_video: '🎬 影片: 1080p @ 原始影格率, 高位元率 (0.10)',
          spec_audio: '🎵 音訊: AAC 128k 保持原始',
          spec_img_doc: '🖼️ 圖片/文件: 1080p 上限, 品質: 85 (圖表保持PNG)'
        },
        custom: {
          badge: '進階自訂',
          title: '自訂模式',
          desc: '完全手動控制編解碼器、解析度、影格率及品質設定。',
          spec_codecs: '🔧 影片編解碼器: AVC, HEVC, VP9, AV1',
          spec_images: '🎨 圖片: 支援 WebP, JPEG, PNG 滑桿調節'
        }
      },
      custom_controls: {
        video_title: '影片壓縮選項',
        res_cap: '解析度上限',
        res_original: '原始尺寸',
        res_1080p: '1080p (1920 × 1080)',
        res_720p: '720p (1280 × 720)',
        res_480p: '480p (854 × 480)',
        framerate: '影格率',
        fps_original: '原始影格率',
        fps_30: '30 fps',
        fps_24: '24 fps',
        fps_15: '15 fps (建議)',
        fps_10: '10 fps',
        rate_control: '位元率控制模式',
        rc_quality_factor: '動態品質係數',
        rc_bitrate: '目標位元率 (kbps)',
        rc_target_size: '目標檔案大小 (MB)',
        quality_factor: '品質係數',
        qf_low: '低 (0.05) - 精簡體積',
        qf_good: '良好 (0.08) - 平衡',
        qf_high: '高 (0.10) - 簡報級',
        qf_very_high: '極高 (0.15) - 典藏級',
        exact_bitrate: '影片位元率 (kbps)',
        target_size: '目標大小 (MB)',
        hardware_codec: '硬體編解碼器',
        codec_auto: '自動 (最高支援設定檔)',
        codec_detecting: '自動 (正在偵測支援...)',
        codec_disabled: '影片編碼已停用 (WebCodecs無法使用)',
        audio_mode: '音訊模式',
        audio_aac: '轉碼為 AAC',
        audio_opus: '轉碼為 Opus',
        audio_passthrough: '直通原始音訊',
        audio_mute: '靜音 (無音訊)',
        audio_bitrate: '音訊位元率',
        audio_bitrate_32k: '32 kbps (極低)',
        audio_bitrate_48k: '48 kbps (語音/低)',
        audio_bitrate_64k: '64 kbps (適度)',
        audio_bitrate_96k: '96 kbps (標準)',
        audio_bitrate_128k: '128 kbps (高傳真)',
        audio_bitrate_160k: '160 kbps (錄音室)',
        audio_bitrate_192k: '192 kbps (最高)',
        audio_channel: '音訊聲道',
        channel_original: '保持原始',
        channel_stereo: '立體聲 (雙聲道)',
        channel_mono: '單聲道 (1 聲道)',
        container: '封裝格式',
        container_mp4: 'MP4 容器 (.mp4)',
        container_mkv: 'Matroska / WebM (.mkv)',
        img_title: '獨立與嵌入圖片選項',
        img_format: '輸出格式',
        img_format_auto: '自動偵測 (介面圖PNG, 照片WebP)',
        img_format_webp: 'WebP (高壓縮率)',
        img_format_jpeg: 'JPEG (標準相片)',
        img_format_png: 'PNG (無損/圖表)',
        img_quality: '壓縮品質',
        img_res: '最大邊界限制',
        img_res_original: '原始尺寸',
        img_res_1080p: '1080p (最大 1920 × 1080)',
        img_res_720p: '720p (最大 1280 × 720)',
        img_res_480p: '480p (最大 854 × 480)',
        note_doc_img: 'ℹ️ 文件嵌入圖片為確保向下相容，嚴格強制使用 JPEG/PNG。',
        note_doc_video: 'ℹ️ 文件嵌入影片一律轉碼為 MP4 容器下的 AVC + AAC。'
      },
      dropzone: {
        heading: '拖放檔案或資料夾至此處',
        subtext: '或點擊從您的電腦中瀏覽選取',
        format_word: 'Word (.docx, .doc)',
        format_ppt: 'PowerPoint (.pptx, .ppt)',
        format_excel: 'Excel (.xlsx, .xls)',
        format_pdf: 'PDF (.pdf)',
        format_videos: '影片 (.mp4, .mov, .avi, .mkv, .webm, .mts, .m2ts)',
        format_audios: '音訊 (.m4a, .mp3, .wav, .aac, .ogg, .flac)',
        format_images: '圖片 (.jpg, .png, .webp, .tiff, .bmp, .gif)'
      },
      queue: {
        batch_progress: '批次進度',
        status: '狀態',
        space_savings: '已節省空間',
        files_completed: '已完成 {completed}/{total} 個檔案',
        saved_amount: '已節省: {amount} (-{pct}%)',
        saved_zero: '已節省: 0 B',
        btn_start: '⚡ 開始壓縮',
        btn_download_zip: '📦 全部下載 (ZIP)',
        btn_compressing_zip: '⏳ 正在打包 ZIP...',
        btn_clear: '✕ 清空佇列',
        th_name: '檔案名稱',
        th_type: '類型',
        th_orig_size: '原始大小',
        th_comp_size: '壓縮後大小',
        th_space_saved: '節省空間',
        th_status: '狀態',
        th_actions: '操作'
      },
      status: {
        queued: '排隊中',
        completed: '✓ 已完成',
        skipped: '⚠️ 已略過',
        error: '⚠️ 錯誤',
        intact: '保持原樣 (0%)'
      },
      actions: {
        save: '💾 儲存',
        preview: '🔍 預覽',
        remove: '✕'
      },
      modal: {
        visual_comparison: '視覺效果比對',
        comparison_title: '比對: {name}',
        orig_file: '原始檔案',
        comp_output: '壓縮後輸出',
        close_aria: '關閉視窗'
      },
      phases: {
        ready: '就緒',
        starting: '正在啟動',
        analyzing_compressing: '正在分析與壓縮',
        transcoding_video: '正在轉碼影片',
        compressing_audio: '正在壓縮音訊',
        processing_doc: '正在處理文件媒體',
        encoding: '正在編碼',
        completed: '已完成',
        failed: '失敗',
        skipped_no_webcodecs: '已略過（無 WebCodecs）',
        doc_video_intact: '已完成（嵌入影片保持原樣）',
        loading_engine: '正在載入 libav 引擎',
        packaging: '正在重新封裝文件',
        downsampling_pdf_images: '正在壓縮 PDF 圖片',
        saving_pdf: '正在儲存 PDF',
        processing_media: '正在處理文件媒體'
      }
    },

    vi: {
      header: {
        brand_title: 'Office Compressor',
        brand_subtitle: 'Công cụ tối ưu hóa phía client không cần cài đặt',
        libs_ready: '{loaded}/{total} Thư viện sẵn sàng',
        libs_ready_no_video: '{loaded}/{total} Sẵn sàng • Không mã hóa video',
        libs_tooltip: 'Đã tải toàn bộ thư viện nén',
        theme_light: '☀️ Sáng',
        theme_dark: '🌙 Tối',
        theme_toggle_aria: 'Chuyển đổi giao diện',
        lang_select_aria: 'Chọn ngôn ngữ hiển thị'
      },
      webcodecs_warning: {
        title: 'Mã hóa video bị tắt (WebCodecs không khả dụng)',
        reason_unsecure: 'WebCodecs không khả dụng vì trang này được phân phối qua kết nối <strong>HTTP không bảo mật</strong> (không phải localhost). Các video độc lập sẽ bị bỏ qua và video nhúng trong tài liệu sẽ được giữ nguyên. Hãy truy cập qua <strong>HTTPS</strong> hoặc <strong>localhost</strong> để bật tính năng nén video.',
        reason_unsupported: 'Trình duyệt hiện tại không hỗ trợ WebCodecs (VideoEncoder). Tính năng mã hóa video đã bị tắt; video độc lập sẽ bị bỏ qua và video nhúng trong tài liệu sẽ được giữ nguyên. Vui lòng sử dụng trình duyệt hiện đại (Edge, Chrome hoặc Firefox).'
      },
      hero: {
        title_html: 'Nén tài liệu, hình ảnh & video <span class="hero-highlight">bảo mật tuyệt đối</span>',
        desc: 'Nén 100% trên trình duyệt. Mọi quá trình xử lý diễn ra trực tiếp trong bộ nhớ thiết bị mà không tải lên máy chủ. Giảm dung lượng tệp dễ dàng để gửi qua email.'
      },
      presets: {
        title: 'Chọn cấu hình nén',
        email_strict: {
          badge: '< 10 MB',
          title: 'Email nhỏ',
          desc: 'Nén tối đa cho các máy chủ thư doanh nghiệp có giới hạn dung lượng khắt khe (Exchange / Outlook 10MB).',
          spec_video: '🎬 Video: 480p @ 15fps, Bitrate thấp (0.05), AAC 64k',
          spec_audio: '🎵 Âm thanh: AAC 64k Stereo',
          spec_img_doc: '🖼️ Ảnh/Tài liệu: Tối đa 720p, Q: 60'
        },
        email_standard: {
          badge: '< 25 MB',
          title: 'Email tiêu chuẩn',
          desc: 'Cân bằng khuyến nghị giữa chất lượng và kích thước cho tệp đính kèm email (Gmail / Outlook 25MB).',
          spec_video: '🎬 Video: 720p @ 15fps, Bitrate tốt (0.08), AAC 96k',
          spec_audio: '🎵 Âm thanh: AAC 96k Stereo',
          spec_img_doc: '🖼️ Ảnh/Tài liệu: Tối đa 1080p, Q: 75'
        },
        screen_presentation: {
          badge: 'Độ trung thực cao',
          title: 'Trình chiếu màn hình',
          desc: 'Hình ảnh sắc nét tối ưu cho bài thuyết trình, máy chiếu và ảnh chụp màn hình giao diện.',
          spec_video: '🎬 Video: 1080p @ fps gốc, Bitrate cao (0.10)',
          spec_audio: '🎵 Âm thanh: AAC 128k Gốc',
          spec_img_doc: '🖼️ Ảnh/Tài liệu: Tối đa 1080p, Q: 85 (PNG cho biểu đồ)'
        },
        custom: {
          badge: 'Nâng cao',
          title: 'Chế độ tùy chỉnh',
          desc: 'Toàn quyền kiểm soát thủ công về codec, độ phân giải, tốc độ khung hình và chất lượng.',
          spec_codecs: '🔧 Codec video: AVC, HEVC, VP9, AV1',
          spec_images: '🎨 Hình ảnh: Thanh trượt WebP, JPEG, PNG'
        }
      },
      custom_controls: {
        video_title: 'Tùy chọn nén video',
        res_cap: 'Giới hạn độ phân giải',
        res_original: 'Kích thước gốc',
        res_1080p: '1080p (1920 × 1080)',
        res_720p: '720p (1280 × 720)',
        res_480p: '480p (854 × 480)',
        framerate: 'Tốc độ khung hình',
        fps_original: 'Khung hình gốc',
        fps_30: '30 fps',
        fps_24: '24 fps',
        fps_15: '15 fps (Khuyến nghị)',
        fps_10: '10 fps',
        rate_control: 'Chế độ kiểm soát bitrate',
        rc_quality_factor: 'Hệ số chất lượng',
        rc_bitrate: 'Bitrate mục tiêu (kbps)',
        rc_target_size: 'Dung lượng tệp mục tiêu (MB)',
        quality_factor: 'Hệ số chất lượng',
        qf_low: 'Thấp (0.05) - Nhỏ gọn',
        qf_good: 'Tốt (0.08) - Cân bằng',
        qf_high: 'Cao (0.10) - Thuyết trình',
        qf_very_high: 'Rất cao (0.15) - Lưu trữ',
        exact_bitrate: 'Bitrate video (kbps)',
        target_size: 'Dung lượng mục tiêu (MB)',
        hardware_codec: 'Bộ mã hóa phần cứng',
        codec_auto: 'Tự động (Hồ sơ hỗ trợ cao nhất)',
        codec_detecting: 'Tự động (Đang phát hiện...)',
        codec_disabled: 'Mã hóa video bị tắt (WebCodecs không khả dụng)',
        audio_mode: 'Chế độ âm thanh',
        audio_aac: 'Chuyển mã AAC',
        audio_opus: 'Chuyển mã Opus',
        audio_passthrough: 'Giữ nguyên âm thanh gốc',
        audio_mute: 'Tắt tiếng',
        audio_bitrate: 'Bitrate âm thanh',
        audio_bitrate_32k: '32 kbps (Cực thấp)',
        audio_bitrate_48k: '48 kbps (Giọng nói / Thấp)',
        audio_bitrate_64k: '64 kbps (Trung bình thấp)',
        audio_bitrate_96k: '96 kbps (Tiêu chuẩn)',
        audio_bitrate_128k: '128 kbps (Độ trung thực cao)',
        audio_bitrate_160k: '160 kbps (Phòng thu)',
        audio_bitrate_192k: '192 kbps (Tối đa)',
        audio_channel: 'Kênh âm thanh',
        channel_original: 'Giữ nguyên gốc',
        channel_stereo: 'Stereo (2 kênh)',
        channel_mono: 'Mono (1 kênh)',
        container: 'Định dạng đóng gói',
        container_mp4: 'Định dạng MP4 (.mp4)',
        container_mkv: 'Matroska / WebM (.mkv)',
        img_title: 'Tùy chọn hình ảnh độc lập & nhúng',
        img_format: 'Định dạng đầu ra',
        img_format_auto: 'Tự động nhận diện (PNG cho giao diện, WebP cho ảnh)',
        img_format_webp: 'WebP (Nén cao)',
        img_format_jpeg: 'JPEG (Ảnh chụp tiêu chuẩn)',
        img_format_png: 'PNG (Không nén giảm chất lượng/Biểu đồ)',
        img_quality: 'Chất lượng nén',
        img_res: 'Hộp giới hạn tối đa',
        img_res_original: 'Kích thước gốc',
        img_res_1080p: '1080p (Tối đa 1920 × 1080)',
        img_res_720p: '720p (Tối đa 1280 × 720)',
        img_res_480p: '480p (Tối đa 854 × 480)',
        note_doc_img: 'ℹ️ Ảnh nhúng trong tài liệu bắt buộc phải là JPEG/PNG để tương thích ngược.',
        note_doc_video: 'ℹ️ Video nhúng trong tài liệu luôn được chuyển mã sang AVC + AAC trong tệp MP4.'
      },
      dropzone: {
        heading: 'Kéo thả tệp hoặc thư mục vào đây',
        subtext: 'hoặc nhấp để chọn tệp từ máy tính',
        format_word: 'Word (.docx, .doc)',
        format_ppt: 'PowerPoint (.pptx, .ppt)',
        format_excel: 'Excel (.xlsx, .xls)',
        format_pdf: 'PDF (.pdf)',
        format_videos: 'Video (.mp4, .mov, .avi, .mkv, .webm, .mts, .m2ts)',
        format_audios: 'Âm thanh (.m4a, .mp3, .wav, .aac, .ogg, .flac)',
        format_images: 'Hình ảnh (.jpg, .png, .webp, .tiff, .bmp, .gif)'
      },
      queue: {
        batch_progress: 'Tiến trình hàng đợi',
        status: 'Trạng thái',
        space_savings: 'Dung lượng tiết kiệm',
        files_completed: 'Đã hoàn thành {completed}/{total} tệp',
        saved_amount: 'Đã giảm: {amount} (-{pct}%)',
        saved_zero: 'Đã giảm: 0 B',
        btn_start: '⚡ Bắt đầu nén',
        btn_download_zip: '📦 Tải về tất cả (ZIP)',
        btn_compressing_zip: '⏳ Đang nén ZIP...',
        btn_clear: '✕ Xóa hàng đợi',
        th_name: 'Tên tệp',
        th_type: 'Loại',
        th_orig_size: 'Dung lượng gốc',
        th_comp_size: 'Dung lượng nén',
        th_space_saved: 'Đã tiết kiệm',
        th_status: 'Trạng thái',
        th_actions: 'Thao tác'
      },
      status: {
        queued: 'Đang chờ',
        completed: '✓ Đã xong',
        skipped: '⚠️ Đã bỏ qua',
        error: '⚠️ Lỗi',
        intact: 'Giữ nguyên (0%)'
      },
      actions: {
        save: '💾 Lưu',
        preview: '🔍 Xem trước',
        remove: '✕'
      },
      modal: {
        visual_comparison: 'So sánh trực quan',
        comparison_title: 'So sánh: {name}',
        orig_file: 'Tệp gốc',
        comp_output: 'Sau khi nén',
        close_aria: 'Đóng cửa sổ'
      },
      phases: {
        ready: 'Sẵn sàng',
        starting: 'Đang bắt đầu',
        analyzing_compressing: 'Đang phân tích & nén',
        transcoding_video: 'Đang chuyển mã video',
        compressing_audio: 'Đang nén âm thanh',
        processing_doc: 'Đang xử lý tài liệu',
        encoding: 'Đang mã hóa',
        completed: 'Hoàn thành',
        failed: 'Thất bại',
        skipped_no_webcodecs: 'Đã bỏ qua (Không có WebCodecs)',
        doc_video_intact: 'Đã hoàn thành (Video nhúng giữ nguyên)',
        loading_engine: 'Đang tải engine libav',
        packaging: 'Đang đóng gói tài liệu',
        downsampling_pdf_images: 'Đang nén hình ảnh PDF',
        saving_pdf: 'Đang lưu PDF',
        processing_media: 'Đang xử lý tài liệu'
      }
    }
  };

  // --- Zero-Dependency DOM Translation Engine (< 100 LOC) ---

  const SUPPORTED_LANGS = ['en', 'zh-CN', 'zh-TW', 'vi'];
  let currentLang = 'en';

  function detectLanguage() {
    try {
      const saved = localStorage.getItem('oc_lang');
      if (saved && SUPPORTED_LANGS.includes(saved)) return saved;
      const nav = (typeof navigator !== 'undefined' && (navigator.language || navigator.userLanguage) || '').toLowerCase();
      if (nav.startsWith('zh-tw') || nav.startsWith('zh-hk') || nav.startsWith('zh-mo') || nav.includes('hant')) return 'zh-TW';
      if (nav.startsWith('zh')) return 'zh-CN';
      if (nav.startsWith('vi')) return 'vi';
    } catch (_) {}
    return 'en';
  }

  function t(path, params) {
    const dict = TRANSLATIONS[currentLang] || TRANSLATIONS['en'];
    const fallback = TRANSLATIONS['en'];
    const keys = path.split('.');
    let val = keys.reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), dict);
    if (val === undefined) {
      val = keys.reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), fallback);
    }
    if (typeof val !== 'string') return path;
    if (params && typeof params === 'object') {
      return val.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? params[k] : `{${k}}`));
    }
    return val;
  }

  function formatPhase(phaseCode, progress) {
    if (!phaseCode) return t('phases.ready');
    const phaseKey = `phases.${phaseCode}`;
    const baseText = t(phaseKey);
    const text = baseText !== phaseKey ? baseText : phaseCode;
    return (typeof progress === 'number' && progress > 0 && progress < 100) ? `${text} (${progress}%)` : text;
  }

  function translateDOM(root) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') return;

    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    });
    scope.querySelectorAll('[data-i18n-html]').forEach((el) => {
      const key = el.getAttribute('data-i18n-html');
      if (key) el.innerHTML = t(key);
    });
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      if (key) el.title = t(key);
    });
    scope.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      const key = el.getAttribute('data-i18n-aria');
      if (key) el.setAttribute('aria-label', t(key));
    });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (key) el.placeholder = t(key);
    });
  }

  function setLanguage(lang) {
    if (!SUPPORTED_LANGS.includes(lang)) return;
    currentLang = lang;
    try { localStorage.setItem('oc_lang', lang); } catch (_) {}
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.setAttribute('lang', lang);
    }
    translateDOM();
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('languagechange', { detail: { lang } }));
    }
  }

  function init(defaultLang) {
    currentLang = defaultLang || detectLanguage();
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.setAttribute('lang', currentLang);
    }
    translateDOM();
    return currentLang;
  }

  const I18n = {
    init,
    t,
    formatPhase,
    translateDOM,
    setLanguage,
    getLanguage: () => currentLang,
    SUPPORTED_LANGS,
    TRANSLATIONS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = I18n;
  } else {
    globalScope.I18n = I18n;
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this)));
