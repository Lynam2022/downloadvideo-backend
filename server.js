require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ytdl = require('@distube/ytdl-core');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const os = require('os');
const { getSubtitles: getYTSubtitles } = require('@treeee/youtube-caption-extractor');
const ytDlp = require('yt-dlp-exec');
const ffmpeg = require('fluent-ffmpeg');
const { JSDOM } = require('jsdom');

// Khởi tạo logger với winston
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console()
    ]
});

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json({
    limit: '10kb',
    verify: (req, res, buf) => {
        try {
            JSON.parse(buf);
        } catch (e) {
            res.status(400).json({ error: `Invalid JSON: ${e.message}` });
            throw new Error('Invalid JSON');
        }
    }
}));
app.use(express.static('public'));

// Middleware xử lý CORS (giới hạn origin)
const allowedOrigins = ['http://localhost:3000', 'https://yourdomain.com'];
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    next();
});

// Rate Limiter toàn cục
const globalRateLimiter = new RateLimiterMemory({
    points: 100,
    duration: 60,
});
app.use(async (req, res, next) => {
    try {
        await globalRateLimiter.consume(req.ip);
        next();
    } catch (error) {
        logger.warn(`Global rate limit exceeded for IP: ${req.ip}`);
        res.status(429).json({ error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau!' });
    }
});

// Rate Limiter cho tải file
const downloadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5
});
app.use('/downloads', downloadLimiter);

// Rate Limiter: Giới hạn 50 request/phút cho endpoint tải video
const rateLimiter = new RateLimiterMemory({
    points: 50,
    duration: 60,
});

// Rate Limiter cho tải phụ đề: Giới hạn 5 request/giây
const subtitleRateLimiter = new RateLimiterMemory({
    points: 5,
    duration: 1,
});

// Hàm gọi API với retry mechanism (tăng retries và timeout)
async function fetchWithRetry(url, options, retries = 5, delay = 2000) {
    for (let i = 0; i <= retries; i++) {
        try {
            const response = await axios(url, { ...options, timeout: 60000 }); // Tăng timeout lên 60s
            return response;
        } catch (error) {
            logger.warn(`Retry ${i + 1}/${retries + 1} failed for ${url}: ${error.message}`);
            if (i === retries) throw error;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Hàm kiểm tra tính khả dụng của FFmpeg và codec
async function checkFFmpeg() {
    return new Promise((resolve) => {
        require('child_process').exec('ffmpeg -version', (err) => {
            if (err) {
                logger.error('FFmpeg is not installed or accessible');
                resolve(false);
                return;
            }
            
            // Kiểm tra codec MP3
            require('child_process').exec('ffmpeg -codecs | findstr mp3', (codecErr) => {
                if (codecErr) {
                    logger.error('MP3 codec is not available in FFmpeg');
                    resolve(false);
                    return;
                }
                resolve(true);
            });
        });
    });
}

// Hàm kiểm tra tính khả dụng của phụ đề
async function checkSubtitleAvailability(url, language) {
    try {
        const info = await ytdl.getInfo(url, { timeout: 30000 });
        const captions = info.player_response.captions;
        if (!captions || !captions.playerCaptionsTracklistRenderer) {
            return { available: false, reason: 'Video không có phụ đề nào' };
        }

        const captionTracks = captions.playerCaptionsTracklistRenderer.captionTracks || [];
        const translationLanguages = captions.playerCaptionsTracklistRenderer.translationLanguages || [];
        
        const hasManualSub = captionTracks.some(track => track.languageCode === language);
        const hasAutoSub = translationLanguages.some(tLang => tLang.languageCode === language);

        if (!hasManualSub && !hasAutoSub) {
            return { 
                available: false, 
                reason: `Không tìm thấy phụ đề cho ngôn ngữ ${language}`,
                availableLanguages: {
                    manual: captionTracks.map(track => track.languageCode),
                    auto: translationLanguages.map(tLang => tLang.languageCode)
                }
            };
        }

        return { 
            available: true,
            isAuto: !hasManualSub && hasAutoSub
        };
    } catch (error) {
        logger.error(`Error checking subtitle availability: ${error.message}`);
        return { available: false, reason: 'Không thể kiểm tra tính khả dụng của phụ đề' };
    }
}

// Hàm lấy thông tin video từ @distube/ytdl-core
async function getVideoInfo(url) {
    try {
        const info = await ytdl.getInfo(url, {
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            }
        });
        return info;
    } catch (error) {
        logger.error(`Error getting video info: ${error.message}`, {
            error: error.stack,
            url: url
        });
        throw error;
    }
}

// Hàm tải phụ đề với @distube/ytdl-core
async function downloadSubtitleWithYtdlCore(url, language, isAuto = false) {
    try {
        const info = await getVideoInfo(url);
        const captions = info.player_response.captions;
        
        if (!captions || !captions.playerCaptionsTracklistRenderer) {
            throw new Error('Video không có phụ đề nào');
        }

        const captionTracks = captions.playerCaptionsTracklistRenderer.captionTracks || [];
        const translationLanguages = captions.playerCaptionsTracklistRenderer.translationLanguages || [];
        
        let subtitleUrl = null;
        let selectedTrack = null;

        if (!isAuto) {
            selectedTrack = captionTracks.find(track => track.languageCode === language);
            if (selectedTrack) {
                subtitleUrl = selectedTrack.baseUrl;
            }
        } else {
            // Thử tìm phụ đề tự động
            const autoTrack = captionTracks.find(track => track.kind === 'asr');
            if (autoTrack) {
                selectedTrack = autoTrack;
                subtitleUrl = `${autoTrack.baseUrl}&tlang=${language}`;
            } else {
                // Nếu không tìm thấy phụ đề tự động, thử dùng phụ đề thủ công
                const manualTrack = captionTracks[0];
                if (manualTrack) {
                    selectedTrack = manualTrack;
                    subtitleUrl = `${manualTrack.baseUrl}&tlang=${language}`;
                }
            }
        }

        if (!subtitleUrl) {
            throw new Error(`Không tìm thấy phụ đề cho ngôn ngữ ${language}`);
        }

        logger.info(`Downloading subtitle from URL: ${subtitleUrl}`, {
            language,
            isAuto,
            trackInfo: selectedTrack ? {
                languageCode: selectedTrack.languageCode,
                kind: selectedTrack.kind,
                name: selectedTrack.name?.simpleText
            } : null
        });

        // Thử tải phụ đề với retry
        let retries = 3;
        let lastError = null;
        let lastResponse = null;

        while (retries > 0) {
            try {
                const response = await axios.get(subtitleUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1'
                    },
                    timeout: 30000
                });

                lastResponse = response;

                if (!response.data || response.data.trim() === '') {
                    throw new Error('Nội dung phụ đề trống từ server');
                }

                // Kiểm tra nếu là XML
                if (response.data.includes('<?xml') || response.data.includes('<transcript>')) {
                    const vttContent = convertXmlToVtt(response.data);
                    if (!vttContent) {
                        throw new Error('Không thể chuyển đổi XML sang VTT');
                    }
                    return vttContent;
                }

                // Kiểm tra nếu là VTT
                if (response.data.includes('WEBVTT')) {
                    return response.data;
                }

                // Nếu không phải XML hoặc VTT, thử chuyển đổi sang VTT
                try {
                    const vttContent = convertXmlToVtt(response.data);
                    if (vttContent) {
                        return vttContent;
                    }
                } catch (error) {
                    logger.warn(`Failed to convert content to VTT: ${error.message}`);
                }

                // Nếu không thể chuyển đổi, trả về nội dung gốc
                return response.data;
            } catch (error) {
                lastError = error;
                retries--;
                if (retries > 0) {
                    logger.warn(`Retrying subtitle download (${retries} attempts left): ${error.message}`, {
                        responseStatus: lastResponse?.status,
                        responseHeaders: lastResponse?.headers,
                        errorDetails: error.response?.data
                    });
                    await new Promise(resolve => setTimeout(resolve, 2000)); // Đợi 2 giây trước khi thử lại
                }
            }
        }

        // Log chi tiết lỗi cuối cùng
        logger.error('Subtitle download failed after all retries', {
            lastError: lastError?.message,
            responseStatus: lastResponse?.status,
            responseHeaders: lastResponse?.headers,
            errorDetails: lastError?.response?.data,
            url: subtitleUrl,
            language,
            isAuto
        });

        throw lastError || new Error('Không thể tải phụ đề sau nhiều lần thử');
    } catch (error) {
        logger.error(`Error downloading subtitle with ytdl-core: ${error.message}`, {
            error: error.stack,
            url: url,
            language: language,
            isAuto: isAuto
        });
        throw error;
    }
}

// Hàm tải video/âm thanh với @distube/ytdl-core
async function downloadMediaWithYtdlCore(url, type, quality) {
    try {
        // List of user agents to try
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.159 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15'
        ];

        let lastError = null;
        let selectedFormat = null;
        let info = null;

        // Try each user agent
        for (const userAgent of userAgents) {
            try {
                info = await ytdl.getInfo(url, {
                    requestOptions: {
                        headers: {
                            'User-Agent': userAgent,
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.5',
                            'Connection': 'keep-alive',
                            'Upgrade-Insecure-Requests': '1'
                        }
                    }
                });
                break; // If successful, break the loop
            } catch (error) {
                lastError = error;
                logger.warn(`Failed to get video info with user agent ${userAgent}: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retrying
            }
        }

        if (!info) {
            throw new Error(`Failed to get video info after trying all user agents: ${lastError?.message}`);
        }

        const formats = info.formats;
        
        logger.info(`Available formats for ${url}:`, {
            totalFormats: formats.length,
            formats: formats.map(f => ({
                itag: f.itag,
                quality: f.qualityLabel || f.audioBitrate,
                container: f.container,
                hasVideo: f.hasVideo,
                hasAudio: f.hasAudio,
                mimeType: f.mimeType
            }))
        });

        // Lọc định dạng phù hợp
        if (type === 'video') {
            // Định nghĩa các mức chất lượng
            const qualityMap = {
                high: ['1080p', '720p', '480p'],
                medium: ['720p', '480p', '360p'],
                low: ['480p', '360p', '240p']
            };
            const preferredQualities = qualityMap[quality] || qualityMap['high'];

            // Thử tìm định dạng phù hợp theo thứ tự ưu tiên
            for (const q of preferredQualities) {
                // Tìm định dạng có cả video và audio
                selectedFormat = formats.find(f => {
                    const hasVideo = f.hasVideo;
                    const hasAudio = f.hasAudio;
                    const qualityMatch = f.qualityLabel === q;
                    return hasVideo && hasAudio && qualityMatch;
                });

                if (selectedFormat) break;

                // Nếu không tìm thấy, thử tìm định dạng video có chất lượng phù hợp
                selectedFormat = formats.find(f => {
                    const hasVideo = f.hasVideo;
                    const qualityMatch = f.qualityLabel === q;
                    return hasVideo && qualityMatch;
                });

                if (selectedFormat) break;
            }

            // Nếu vẫn không tìm thấy, lấy định dạng video đầu tiên
            if (!selectedFormat) {
                selectedFormat = formats.find(f => f.hasVideo);
            }
        } else {
            // Cho audio, ưu tiên định dạng có sẵn MP3
            selectedFormat = formats.find(f => {
                const hasAudio = f.hasAudio;
                const noVideo = !f.hasVideo;
                const isMP3 = f.container === 'mp3' || f.mimeType.includes('mp3');
                return hasAudio && noVideo && isMP3;
            });

            // Nếu không tìm thấy MP3, lấy định dạng audio bất kỳ
            if (!selectedFormat) {
                selectedFormat = formats.find(f => {
                    const hasAudio = f.hasAudio;
                    const noVideo = !f.hasVideo;
                    return hasAudio && noVideo;
                });
            }
        }

        if (!selectedFormat) {
            throw new Error(`Không tìm thấy định dạng phù hợp cho ${type}. Vui lòng thử lại với chất lượng khác.`);
        }

        logger.info(`Selected format:`, {
            itag: selectedFormat.itag,
            quality: selectedFormat.qualityLabel || selectedFormat.audioBitrate,
            container: selectedFormat.container,
            hasVideo: selectedFormat.hasVideo,
            hasAudio: selectedFormat.hasAudio,
            mimeType: selectedFormat.mimeType
        });

        // Try downloading with different user agents
        let lastDownloadError = null;
        for (const userAgent of userAgents) {
            try {
                const stream = ytdl(url, {
                    quality: selectedFormat.itag,
                    filter: type === 'audio' ? 'audioonly' : undefined,
                    requestOptions: {
                        headers: {
                            'User-Agent': userAgent,
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.5',
                            'Connection': 'keep-alive',
                            'Upgrade-Insecure-Requests': '1'
                        }
                    }
                });

                // Test the stream
                await new Promise((resolve, reject) => {
                    stream.on('error', reject);
                    stream.on('data', () => {
                        stream.removeAllListeners('error');
                        resolve();
                    });
                });

                return { format: selectedFormat, stream };
            } catch (error) {
                lastDownloadError = error;
                logger.warn(`Failed to download with user agent ${userAgent}: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retrying
            }
        }

        throw new Error(`Failed to download after trying all user agents: ${lastDownloadError?.message}`);
    } catch (error) {
        logger.error(`Error downloading media with ytdl-core: ${error.message}`, {
            error: error.stack,
            url: url,
            type: type,
            quality: quality
        });
        throw error;
    }
}

// Hàm xóa file cũ nhất nếu vượt quá giới hạn
async function cleanFolder(folderPath, maxFiles = 10) {
    try {
        const exists = await fsPromises.access(folderPath).then(() => true).catch(() => false);
        if (!exists) return;

        const files = await fsPromises.readdir(folderPath);
        const fileStats = [];

        for (const file of files) {
            const filePath = path.join(folderPath, file);
            const stats = await fsPromises.stat(filePath);
            if (stats.isFile()) {
                fileStats.push({ file, mtimeMs: stats.mtimeMs });
            }
        }

        if (fileStats.length > maxFiles) {
            fileStats.sort((a, b) => a.mtimeMs - b.mtimeMs);
            const fileToDelete = path.join(folderPath, fileStats[0].file);
            logger.info(`Chuẩn bị xóa file cũ nhất: ${fileToDelete}`);
            await fsPromises.unlink(fileToDelete);
            logger.info(`Đã xóa file cũ nhất: ${fileToDelete}`);
        }
    } catch (error) {
        logger.error(`Error cleaning folder ${folderPath}: ${error.message}`);
    }
}

// Hàm xử lý tiêu đề thành tên file hợp lệ
function sanitizeFileName(title) {
    return title
        .replace(/[<>:"\/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, '_')
        .substring(0, 50)
        .trim();
}

// Hàm kiểm tra tính khả dụng của video YouTube
async function checkVideoAvailability(videoId) {
    try {
        const response = await fetchWithRetry(`https://www.googleapis.com/youtube/v3/videos`, {
            params: {
                part: 'status',
                id: videoId,
                key: process.env.YOUTUBE_API_KEY
            }
        });
        const video = response.data.items[0];
        if (!video) {
            return { isAvailable: false, reason: 'Video không tồn tại hoặc đã bị xóa.' };
        }
        if (video.status.uploadStatus !== 'processed') {
            return { isAvailable: false, reason: 'Video chưa được xử lý hoàn tất.' };
        }
        return { isAvailable: true };
    } catch (error) {
        logger.error(`Error checking video availability: ${error.message}`);
        return { isAvailable: false, reason: 'Không thể kiểm tra tính khả dụng của video.' };
    }
}

// Hàm lấy tiêu đề video từ YouTube API
async function getVideoTitle(videoId) {
    try {
        const response = await fetchWithRetry(`https://www.googleapis.com/youtube/v3/videos`, {
            params: {
                part: 'snippet',
                id: videoId,
                key: process.env.YOUTUBE_API_KEY
            }
        });
        const item = response.data.items[0];
        if (item) {
            return sanitizeFileName(item.snippet.title);
        }
        return `Video_YouTube_${videoId}`;
    } catch (error) {
        logger.error(`Error fetching video title: ${error.message}`);
        return `Video_YouTube_${videoId}`;
    }
}

// Hàm cắt đoạn văn bản nếu vượt quá giới hạn ký tự
function truncateSubtitleText(text, maxLength = 40) {
    if (!text) return '';
    text = text.trim();
    if (text.length <= maxLength) return text;

    let lastSpaceIndex = text.lastIndexOf(' ', maxLength);
    if (lastSpaceIndex === -1) lastSpaceIndex = maxLength;
    return text.substring(0, lastSpaceIndex).trim();
}

// Hàm chuyển đổi phụ đề sang VTT (chỉ giữ thời gian và văn bản)
function arrayToVtt(subtitles) {
    if (!subtitles || subtitles.length === 0) return null;
    let vtt = 'WEBVTT\n\n';
    subtitles.forEach((sub) => {
        const start = sub.startMs ? msToTime(sub.startMs) : msToTime(sub.start * 1000);
        const end = sub.startMs ? msToTime(sub.startMs + sub.durationMs) : msToTime(sub.end * 1000);
        const text = sub.subtitle || sub.text;
        if (text && text.trim()) {
            const truncatedText = truncateSubtitleText(text);
            vtt += `${start} --> ${end}\n${truncatedText}\n\n`;
        }
    });
    return vtt.trim() === 'WEBVTT' ? null : vtt.trim();
}

// Hàm chuyển đổi phụ đề sang SRT (chỉ giữ thời gian và văn bản, có số thứ tự)
function arrayToSrt(subtitles) {
    if (!subtitles || subtitles.length === 0) return null;
    let srt = '';
    subtitles.forEach((sub, index) => {
        const start = sub.startMs ? msToTimeSrt(sub.startMs) : msToTimeSrt(sub.start * 1000);
        const end = sub.startMs ? msToTimeSrt(sub.startMs + sub.durationMs) : msToTimeSrt(sub.end * 1000);
        const text = sub.subtitle || sub.text;
        if (text && text.trim()) {
            const truncatedText = truncateSubtitleText(text);
            srt += `${index + 1}\n${start} --> ${end}\n${truncatedText}\n\n`;
        }
    });
    return srt.trim() === '' ? null : srt.trim();
}

// Hàm chuyển đổi phụ đề sang TXT (chỉ văn bản, không thời gian)
function arrayToTxt(subtitles) {
    if (!subtitles || subtitles.length === 0) return null;
    const text = subtitles
        .filter(sub => (sub.subtitle || sub.text) && (sub.subtitle || sub.text).trim())
        .map(sub => truncateSubtitleText(sub.subtitle || sub.text))
        .join('\n\n');
    return text.trim() === '' ? null : text.trim();
}

// Hàm chuyển đổi thời gian từ milliseconds sang định dạng VTT
function msToTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const milliseconds = Math.floor((ms % 1000));
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(milliseconds, 3)}`;
}

// Hàm chuyển đổi thời gian từ milliseconds sang định dạng SRT
function msToTimeSrt(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const milliseconds = Math.floor((ms % 1000));
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(milliseconds, 3)}`;
}

// Hàm bổ sung số 0 cho định dạng thời gian
function pad(num, size = 2) {
    return num.toString().padStart(size, '0');
}

// Hàm chuyển đổi XML sang VTT
function convertXmlToVtt(xmlText) {
    try {
        // Kiểm tra nếu là XML
        if (!xmlText.includes('<?xml') && !xmlText.includes('<transcript>')) {
            return xmlText; // Trả về nguyên bản nếu không phải XML
        }

        const dom = new JSDOM(xmlText, { contentType: "text/xml" });
        const xmlDoc = dom.window.document;
        const textElements = xmlDoc.getElementsByTagName("text");
        
        if (textElements.length === 0) {
            logger.error('No text elements found in XML');
            return null;
        }

        let vttText = "WEBVTT\n\n";
        let hasValidContent = false;
        
        for (let i = 0; i < textElements.length; i++) {
            const text = textElements[i];
            const start = parseFloat(text.getAttribute("start"));
            const dur = parseFloat(text.getAttribute("dur"));
            
            if (isNaN(start) || isNaN(dur)) {
                logger.warn(`Invalid timestamp at index ${i}: start=${start}, dur=${dur}`);
                continue;
            }

            const end = start + dur;
            const startTime = msToTime(start * 1000);
            const endTime = msToTime(end * 1000);
            
            // Xử lý nội dung text
            let content = text.textContent
                .replace(/&amp;quot;/g, '"')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&nbsp;/g, ' ')
                .replace(/\n/g, ' ')
                .trim();

            if (content) {
                vttText += `${startTime} --> ${endTime}\n${content}\n\n`;
                hasValidContent = true;
            }
        }

        if (!hasValidContent) {
            logger.error('No valid content found after XML conversion');
            return null;
        }

        return vttText.trim();
    } catch (error) {
        logger.error(`XML to VTT conversion failed: ${error.message}`, {
            error: error.stack,
            xmlContent: xmlText
        });
        return null;
    }
}

// Hàm trích xuất văn bản từ VTT thành TXT
function extractTextFromVtt(vttText) {
    if (!vttText || vttText.trim() === '') {
        logger.error('Empty VTT content for text extraction');
        return null;
    }

    try {
        // Kiểm tra nếu là XML
        if (vttText.includes('<?xml') || vttText.includes('<transcript>')) {
            vttText = convertXmlToVtt(vttText);
            if (!vttText) {
                throw new Error('Failed to convert XML to VTT');
            }
        }

        const lines = vttText.split('\n');
        let text = '';
        let i = 0;
        let debugInfo = {
            totalLines: lines.length,
            contentLines: 0,
            emptyLines: 0,
            hasValidContent: false
        };

        // Bỏ qua header WEBVTT và các dòng trống đầu tiên
        while (i < lines.length && (lines[i].startsWith('WEBVTT') || lines[i].trim() === '')) {
            i++;
        }

        while (i < lines.length) {
            if (lines[i].match(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/)) {
                i++;
                let subtitleText = '';
                let hasText = false;

                while (i < lines.length && lines[i].trim() !== '') {
                    debugInfo.contentLines++;
                    let cleanLine = lines[i]
                        .replace(/<[^>]+>/g, '')
                        .replace(/align:start/g, '')
                        .replace(/position:\d+%/g, '')
                        .replace(/\d{2}:\d{2}:\d{2}\.\d{3}/g, '')
                        .replace(/<c>/g, '')
                        .replace(/<\/c>/g, '')
                        .replace(/&nbsp;/g, ' ')
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&quot;/g, '"')
                        .replace(/&#39;/g, "'")
                        .replace(/\u200B/g, '')
                        .replace(/\u200C/g, '')
                        .replace(/\u200D/g, '')
                        .replace(/\u200E/g, '')
                        .replace(/\u200F/g, '')
                        .trim();

                    if (cleanLine) {
                        subtitleText += (subtitleText ? '\n' : '') + cleanLine;
                        hasText = true;
                    }
                    i++;
                }

                if (hasText) {
                    const truncatedText = truncateSubtitleText(subtitleText);
                    text += (text ? '\n\n' : '') + truncatedText;
                    debugInfo.hasValidContent = true;
                }
            } else {
                if (lines[i].trim() === '') {
                    debugInfo.emptyLines++;
                }
                i++;
            }
        }

        if (!debugInfo.hasValidContent) {
            logger.error('No valid text content found in VTT', {
                debugInfo,
                vttContent: vttText
            });
            return null;
        }

        const result = text.trim();
        if (result === '') {
            logger.error('Empty text content after extraction', {
                debugInfo,
                vttContent: vttText
            });
            return null;
        }

        logger.info(`Extracted text content from VTT`, { debugInfo });
        return result;
    } catch (error) {
        logger.error(`Text extraction from VTT failed: ${error.message}`, {
            error: error.stack,
            vttContent: vttText
        });
        return null;
    }
}

// Hàm chuyển đổi phụ đề sang định dạng khác
function convertSubtitleFormat(content, format) {
    if (!content || content.trim() === '') {
        logger.error('Empty subtitle content');
        return null;
    }

    try {
        switch (format.toLowerCase()) {
            case 'srt':
                return convertVttToSrt(content);
            case 'txt':
                return extractTextFromVtt(content);
            case 'vtt':
                return content.trim();
            default:
                logger.error(`Unsupported subtitle format: ${format}`);
                return null;
        }
    } catch (error) {
        logger.error(`Subtitle format conversion failed: ${error.message}`);
        return null;
    }
}

// Hàm lấy quốc gia từ IP
async function getCountryFromIP(ip) {
    try {
        const response = await fetchWithRetry(`http://ip-api.com/json/${ip}`, {});
        if (response.data.status !== 'success') {
            throw new Error('Không thể xác định quốc gia từ IP');
        }
        return response.data.countryCode; // Trả về mã quốc gia (ISO 3166-1 alpha-2)
    } catch (error) {
        logger.error(`Error fetching country from IP ${ip}: ${error.message}`);
        return 'DEFAULT'; // Mặc định nếu không xác định được quốc gia
    }
}

// Bảng ánh xạ quốc gia với ngôn ngữ phụ đề mặc định
const countryToLanguageMap = {
    "US": "en", "VN": "vi", "JP": "ja", "FR": "fr", "DE": "de", "CN": "zh", "IN": "hi",
    "BR": "pt", "RU": "ru", "KR": "ko", "CA": "en", "AU": "en", "GB": "en", "IT": "it",
    "ES": "es", "MX": "es", "TH": "th", "ID": "id", "PH": "tl", "MY": "ms", "SG": "en",
    "SA": "ar", "AE": "ar", "EG": "ar", "TR": "tr", "ZA": "en", "NG": "en", "KE": "en",
    "DEFAULT": "en"
};

// Hàm lấy ngôn ngữ mặc định dựa trên IP
async function getDefaultLanguage(ip) {
    const countryCode = await getCountryFromIP(ip);
    return countryToLanguageMap[countryCode] || countryToLanguageMap["DEFAULT"];
}

// Hàm lấy danh sách ngôn ngữ phụ đề từ @distube/ytdl-core
async function getAvailableSubtitleLanguages(url) {
    try {
        const info = await ytdl.getInfo(url, { timeout: 30000 });
        const captions = info.player_response.captions;
        if (!captions || !captions.playerCaptionsTracklistRenderer) {
            return { manual: [], auto: [] };
        }

        const captionTracks = captions.playerCaptionsTracklistRenderer.captionTracks || [];
        const manualLanguages = captionTracks.map(track => track.languageCode);

        const translationLanguages = captions.playerCaptionsTracklistRenderer.translationLanguages || [];
        const autoLanguages = translationLanguages.map(lang => lang.languageCode);

        return { manual: manualLanguages, auto: autoLanguages };
    } catch (ytdlError) {
        logger.error(`Error fetching subtitle languages with @distube/ytdl-core: ${ytdlError.message}`);
        // Fallback: Thử lấy danh sách ngôn ngữ từ yt-dlp
        try {
            const result = await ytDlp(url, {
                listSubs: true,
                skipDownload: true
            }, { stdio: 'pipe' });

            const lines = result.split('\n');
            const languages = { manual: [], auto: [] };

            for (const line of lines) {
                if (line.includes('Available subtitles for')) {
                    const langLines = lines.slice(lines.indexOf(line) + 1);
                    for (const langLine of langLines) {
                        if (langLine.trim() === '' || langLine.includes('Available automatic captions')) break;
                        const langCode = langLine.split(/\s+/)[0];
                        if (langCode) languages.manual.push(langCode);
                    }
                }
                if (line.includes('Available automatic captions for')) {
                    const autoLangLines = lines.slice(lines.indexOf(line) + 1);
                    for (const autoLangLine of autoLangLines) {
                        if (autoLangLine.trim() === '') break;
                        const langCode = autoLangLine.split(/\s+/)[0];
                        if (langCode) languages.auto.push(langCode);
                    }
                }
            }

            return languages;
        } catch (ytDlpError) {
            logger.error(`Error fetching subtitle languages with yt-dlp: ${ytDlpError.message}`);
            return { manual: [], auto: [] };
        }
    }
}

// Hàm kiểm tra danh sách định dạng để chọn định dạng khả dụng
async function getAvailableFormats(videoUrl) {
    logger.info(`Fetching formats for URL: ${videoUrl}`);
    try {
        const info = await ytdl.getInfo(videoUrl, { timeout: 30000 });
        const formats = info.formats;
        return formats.map(format => ({
            itag: format.itag,
            quality: format.qualityLabel || format.audioBitrate,
            container: format.container,
            type: format.mimeType.includes('video') ? 'video' : 'audio'
        }));
    } catch (error) {
        logger.error(`Error in getAvailableFormats with @distube/ytdl-core: ${error.message}`);
        return [];
    }
}

// Hàm chọn định dạng khả dụng dựa trên chất lượng và loại nội dung
async function selectAvailableFormat(videoUrl, quality, type) {
    const formats = await getAvailableFormats(videoUrl);
    if (formats.length === 0) return null;

    const qualityMap = {
        high: ['1080p', '720p'],
        medium: ['720p', '480p'],
        low: ['360p', '240p']
    };
    const preferredQualities = qualityMap[quality] || qualityMap['high'];

    for (let q of preferredQualities) {
        const format = formats.find(f => f.quality === q && f.type.includes(type));
        if (format) return format.itag;
    }

    if (type === 'video') {
        const videoFormat = formats.find(f => f.type.includes('video'));
        if (videoFormat) return videoFormat.itag;
    }

    const audioFormat = formats.find(f => f.type.includes('audio'));
    if (audioFormat) return audioFormat.itag;

    return formats[0]?.itag || null;
}

// Endpoint metadata
app.post('/api/metadata', async (req, res) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        logger.warn(`Invalid request body from IP: ${req.ip}`);
        return res.status(400).json({ error: 'Body yêu cầu không hợp lệ hoặc thiếu dữ liệu. Vui lòng gửi JSON với các trường url và platform.' });
    }

    const { url, platform } = req.body;

    if (!url || !platform) {
        logger.warn(`Missing required fields (url, platform) from IP: ${req.ip}`);
        return res.status(400).json({ error: 'Thiếu thông tin cần thiết (url, platform)' });
    }

    try {
        let metadata = { thumbnail: '', title: '' };

        if (platform === 'youtube') {
            const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?&]+)/)?.[1];
            if (videoId) {
                const youtubeResponse = await fetchWithRetry(`https://www.googleapis.com/youtube/v3/videos`, {
                    params: {
                        part: 'snippet',
                        id: videoId,
                        key: process.env.YOUTUBE_API_KEY
                    }
                });
                const item = youtubeResponse.data.items[0];
                if (item) {
                    metadata.thumbnail = item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default?.url;
                    metadata.title = item.snippet.title || `Video YouTube mẫu - ${videoId}`;
                } else {
                    metadata.thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
                    metadata.title = `Video YouTube mẫu - ${videoId}`;
                }
            } else {
                metadata.thumbnail = '';
                metadata.title = 'Video YouTube mẫu';
            }
        } else {
            try {
                const rapidApiResponse = await fetchWithRetry('https://all-media-downloader1.p.rapidapi.com/media', {
                    method: 'POST',
                    headers: {
                        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
                        'x-rapidapi-host': 'all-media-downloader1.p.rapidapi.com',
                        'Content-Type': 'application/json'
                    },
                    data: { url }
                });
                const data = rapidApiResponse.data;
                if (data && data.metadata) {
                    metadata.thumbnail = data.metadata.thumbnail || '';
                    metadata.title = data.metadata.title || '';
                    if (!metadata.title) {
                        const titleMap = {
                            'tiktok': 'Video TikTok/Douyin mẫu',
                            'douyin': 'Video TikTok/Douyin mẫu',
                            'facebook': 'Video Facebook mẫu',
                            'instagram': 'Bài đăng Instagram mẫu',
                            'twitter': 'Tweet mẫu'
                        };
                        metadata.title = titleMap[platform] || 'Mẫu tiêu đề video';
                    }
                } else {
                    throw new Error('Metadata không hợp lệ từ RapidAPI');
                }
            } catch (rapidError) {
                logger.error(`RapidAPI Metadata Error: ${rapidError.message}`);
                const titleMap = {
                    'tiktok': 'Video TikTok/Douyin mẫu',
                    'douyin': 'Video TikTok/Douyin mẫu',
                    'facebook': 'Video Facebook mẫu',
                    'instagram': 'Bài đăng Instagram mẫu',
                    'twitter': 'Tweet mẫu'
                };
                metadata.title = titleMap[platform] || 'Mẫu tiêu đề video';
            }
        }

        res.json(metadata);
    } catch (error) {
        logger.error(`Metadata Error: ${error.message}`);
        const titleMap = {
            'youtube': 'Video YouTube mẫu',
            'tiktok': 'Video TikTok/Douyin mẫu',
            'douyin': 'Video TikTok/Douyin mẫu',
            'facebook': 'Video Facebook mẫu',
            'instagram': 'Bài đăng Instagram mẫu',
            'twitter': 'Tweet mẫu'
        };
        const fallbackTitle = titleMap[platform] || 'Mẫu tiêu đề video';
        res.status(500).json({ thumbnail: '', title: fallbackTitle });
    }
});

// Endpoint tải video hoặc âm thanh
app.post('/api/download', async (req, res) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        logger.warn(`Invalid request body from IP: ${req.ip}`);
        return res.status(400).json({ error: 'Body yêu cầu không hợp lệ hoặc thiếu dữ liệu. Vui lòng gửi JSON với các trường url và platform.' });
    }

    const { url, platform, type, quality } = req.body;

    if (!url || !platform || !type) {
        logger.warn(`Missing required fields (url, platform, type) from IP: ${req.ip}`);
        return res.status(400).json({ error: 'Thiếu thông tin cần thiết (url, platform, type)' });
    }

    try {
        await rateLimiter.consume('download_endpoint', 1);
        logger.info(`Download request: ${type} from ${platform}, URL: ${url}, IP: ${req.ip}, Quality: ${quality}`);

        const ffmpegAvailable = await checkFFmpeg();
        if (!ffmpegAvailable) {
            logger.error('FFmpeg is not installed or accessible');
            return res.status(500).json({
                error: 'FFmpeg không được cài đặt hoặc không thể truy cập. Vui lòng cài FFmpeg theo hướng dẫn tại https://ffmpeg.org/download.html và thử lại.'
            });
        }

        if (platform === 'youtube') {
            const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?&]+)/)?.[1];
            if (!videoId) {
                logger.warn(`Invalid YouTube URL from IP: ${req.ip}: ${url}`);
                return res.status(400).json({ error: 'URL YouTube không hợp lệ' });
            }

            const availability = await checkVideoAvailability(videoId);
            if (!availability.isAvailable) {
                logger.warn(`Video not available: ${videoId}, reason: ${availability.reason}`);
                return res.status(403).json({ error: availability.reason });
            }

            let videoTitle = await getVideoTitle(videoId);
            const fileExtension = type === 'video' ? 'mp4' : 'mp3';
            const fileName = `${videoTitle}${quality ? `_${quality}` : ''}.${fileExtension}`;
            const filePath = path.join(__dirname, 'downloads', fileName);

            if (!await fsPromises.access(path.join(__dirname, 'downloads')).then(() => true).catch(() => false)) {
                await fsPromises.mkdir(path.join(__dirname, 'downloads'), { recursive: true });
            }

            await cleanFolder(path.join(__dirname, 'downloads'));

            if (await fsPromises.access(filePath).then(() => true).catch(() => false)) {
                logger.info(`File đã tồn tại: ${filePath}`);
                return res.status(200).json({ success: true, downloadUrl: `/downloads/${encodeURIComponent(fileName)}` });
            }

            // Sử dụng @distube/ytdl-core để tải video/âm thanh
            try {
                const { format, stream } = await downloadMediaWithYtdlCore(url, type, quality);
                logger.info(`Selected format: ${JSON.stringify(format)}`);

                const fileStream = fs.createWriteStream(filePath);
                let downloadError = null;
                let downloadProgress = 0;
                
                return new Promise((resolve, reject) => {
                    stream.pipe(fileStream);
                    
                    stream.on('error', (error) => {
                        downloadError = error;
                        logger.error(`Stream error: ${error.message}`, { 
                            error: error.stack,
                            url: url,
                            type: type,
                            format: format
                        });
                        fileStream.end();
                        fs.unlink(filePath, () => {});
                        reject(error);
                    });

                    stream.on('progress', (chunkLength, downloaded, total) => {
                        downloadProgress = (downloaded / total) * 100;
                        logger.info(`Download progress: ${downloadProgress.toFixed(2)}%`);
                    });

                    fileStream.on('error', (error) => {
                        downloadError = error;
                        logger.error(`File stream error: ${error.message}`, {
                            error: error.stack,
                            filePath: filePath
                        });
                        stream.destroy();
                        fs.unlink(filePath, () => {});
                        reject(error);
                    });

                    fileStream.on('finish', () => {
                        fileStream.close();
                        if (type === 'audio') {
                            // Kiểm tra xem file đã là MP3 chưa
                            const isMP3 = format.container === 'mp3' || format.mimeType.includes('mp3');
                            if (isMP3) {
                                // Nếu đã là MP3, chỉ cần đổi tên file
                                fs.rename(filePath, filePath.replace('.mp4', '.mp3'), (err) => {
                                    if (err) {
                                        logger.error(`Error renaming file: ${err.message}`, {
                                            error: err.stack,
                                            from: filePath,
                                            to: filePath.replace('.mp4', '.mp3')
                                        });
                                        reject(err);
                                        return;
                                    }
                                    resolve();
                                });
                            } else {
                                // Nếu không phải MP3, cần chuyển đổi
                                const tempPath = filePath.replace('.mp3', '_temp.mp4');
                                fs.rename(filePath, tempPath, async (err) => {
                                    if (err) {
                                        logger.error(`Error renaming file: ${err.message}`, {
                                            error: err.stack,
                                            from: filePath,
                                            to: tempPath
                                        });
                                        reject(err);
                                        return;
                                    }
                                    try {
                                        await new Promise((resolve, reject) => {
                                            const ffmpegCommand = ffmpeg(tempPath)
                                                .noVideo()
                                                .audioCodec('libmp3lame')
                                                .audioBitrate('192k')
                                                .audioChannels(2)
                                                .on('start', (commandLine) => {
                                                    logger.info(`FFmpeg command: ${commandLine}`);
                                                })
                                                .on('progress', (progress) => {
                                                    logger.info(`FFmpeg progress: ${JSON.stringify(progress)}`);
                                                })
                                                .on('end', () => {
                                                    logger.info('FFmpeg conversion completed successfully');
                                                    resolve();
                                                })
                                                .on('error', (err) => {
                                                    logger.error(`FFmpeg error: ${err.message}`, {
                                                        error: err.stack,
                                                        input: tempPath,
                                                        output: filePath
                                                    });
                                                    reject(err);
                                                });

                                            logger.info('Starting FFmpeg conversion...');
                                            ffmpegCommand.save(filePath);
                                        });
                                        fs.unlink(tempPath, () => {});
                                        resolve();
                                    } catch (error) {
                                        logger.error(`FFmpeg conversion error: ${error.message}`, {
                                            error: error.stack,
                                            input: tempPath,
                                            output: filePath
                                        });
                                        fs.unlink(tempPath, () => {});
                                        reject(error);
                                    }
                                });
                            }
                        } else {
                            resolve();
                        }
                    });
                }).then(() => {
                    if (!fs.existsSync(filePath)) {
                        throw new Error('Download failed, file not created');
                    }
                    const stats = fs.statSync(filePath);
                    if (stats.size === 0) {
                        fs.unlinkSync(filePath);
                        throw new Error('File tải về rỗng');
                    }
                    logger.info(`File tải về thành công: ${filePath}, kích thước: ${stats.size} bytes`);
                    return res.status(200).json({ success: true, downloadUrl: `/downloads/${encodeURIComponent(fileName)}` });
                }).catch((error) => {
                    logger.error(`Download failed: ${error.message}`, {
                        error: error.stack,
                        url: url,
                        type: type,
                        quality: quality,
                        downloadProgress: downloadProgress,
                        downloadError: downloadError
                    });
                    return res.status(500).json({ 
                        error: 'Không thể tải video/âm thanh. Vui lòng thử lại sau!',
                        details: error.message,
                        code: error.code
                    });
                });
            } catch (error) {
                logger.error(`@distube/ytdl-core download failed: ${error.message}`, {
                    error: error.stack,
                    url: url,
                    type: type,
                    quality: quality
                });
                return res.status(500).json({ 
                    error: 'Không thể tải video/âm thanh từ bất kỳ nguồn nào.',
                    details: error.message,
                    code: error.code
                });
            }
        } else {
            try {
                const response = await fetchWithRetry('https://all-media-downloader1.p.rapidapi.com/media', {
                    method: 'POST',
                    headers: {
                        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
                        'x-rapidapi-host': 'all-media-downloader1.p.rapidapi.com',
                        'Content-Type': 'application/json'
                    },
                    data: { url, quality }
                });

                const data = response.data;
                if (data.error) {
                    logger.warn(`RapidAPI returned error: ${data.error}`);
                    return res.status(400).json({ error: data.error });
                }

                if (type === 'video' && data.video) {
                    return res.status(200).json({ downloadUrl: data.video });
                } else if (type === 'audio' && data.audio) {
                    return res.status(200).json({ downloadUrl: data.audio });
                } else {
                    logger.warn(`RapidAPI did not return expected content for type ${type}`);
                    return res.status(400).json({ error: 'Không tìm thấy nội dung để tải. API không trả về link tải.' });
                }
            } catch (rapidError) {
                logger.error(`RapidAPI Download Error: ${rapidError.message}`);
                return res.status(500).json({
                    error: rapidError.message || 'Lỗi từ RapidAPI. Vui lòng kiểm tra API key hoặc thử lại sau.'
                });
            }
        }
    } catch (error) {
        logger.error(`API Error: ${error.message}`, {
            error: error.stack,
            url: url,
            platform: platform,
            type: type,
            quality: quality
        });
        if (error.code === 'ECONNABORTED') {
            return res.status(504).json({ error: 'Yêu cầu tải nội dung hết thời gian. Vui lòng kiểm tra kết nối và thử lại!' });
        } else if (error.code === 'RATE_LIMITER_POINTS_EXCEEDED') {
            return res.status(429).json({ error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau!' });
        }
        return res.status(500).json({ 
            error: error.message || 'Lỗi server khi tải nội dung. Vui lòng thử lại sau!',
            details: error.stack,
            code: error.code
        });
    }
});

// Endpoint tải phụ đề
app.post('/api/download-subtitle', async (req, res) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        logger.warn(`Invalid request body from IP: ${req.ip}`);
        return res.status(400).json({ error: 'Body yêu cầu không hợp lệ hoặc thiếu dữ liệu.' });
    }

    const { url, platform, targetLanguage, formatPreference } = req.body;

    if (!url || !platform) {
        logger.warn(`Missing required fields (url, platform) from IP: ${req.ip}`);
        return res.status(400).json({ error: 'Thiếu thông tin cần thiết (url, platform)' });
    }

    if (!targetLanguage) {
        logger.warn(`No subtitle language selected from IP: ${req.ip}`);
        return res.status(400).json({ error: 'Vui lòng chọn ngôn ngữ phụ đề' });
    }

    try {
        await subtitleRateLimiter.consume(`download_subtitle_${req.ip}`, 1);
        const selectedLanguage = targetLanguage;
        const selectedFormat = formatPreference ? formatPreference.toLowerCase() : 'srt';

        logger.info(`Download subtitle request: ${platform}, URL: ${url}, Language: ${selectedLanguage}, Format: ${selectedFormat}, IP: ${req.ip}`);

        // Kiểm tra FFmpeg
        const ffmpegAvailable = await checkFFmpeg();
        if (!ffmpegAvailable) {
            logger.error('FFmpeg is not installed or accessible');
            return res.status(500).json({
                error: 'FFmpeg không được cài đặt hoặc không thể truy cập. Vui lòng cài FFmpeg theo hướng dẫn tại https://ffmpeg.org/download.html và thử lại.'
            });
        }

        if (platform === 'youtube') {
            const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?&]+)/)?.[1];
            if (!videoId) {
                logger.warn(`Invalid YouTube URL from IP: ${req.ip}: ${url}`);
                return res.status(400).json({ error: 'URL YouTube không hợp lệ' });
            }

            // Kiểm tra tính khả dụng của phụ đề
            const availability = await checkSubtitleAvailability(url, selectedLanguage);
            if (!availability.available) {
                return res.status(404).json({ 
                    error: availability.reason,
                    availableLanguages: availability.availableLanguages
                });
            }

            const subtitlesDir = path.join(__dirname, 'subtitles');
            if (!await fsPromises.access(subtitlesDir).then(() => true).catch(() => false)) {
                await fsPromises.mkdir(subtitlesDir, { recursive: true });
            }

            await cleanFolder(subtitlesDir);

            let videoTitle = await getVideoTitle(videoId);
            let subtitleContent = null;
            let finalSelectedLanguage = selectedLanguage;

            try {
                subtitleContent = await downloadSubtitleWithYtdlCore(url, selectedLanguage, availability.isAuto);
                if (availability.isAuto) {
                    finalSelectedLanguage = `${selectedLanguage}.auto`;
                }
            } catch (error) {
                logger.error(`Subtitle download failed: ${error.message}`);
                return res.status(500).json({ error: error.message });
            }

            if (!subtitleContent || subtitleContent.trim() === '') {
                throw new Error('Nội dung phụ đề rỗng sau khi tải.');
            }

            let contentToWrite = subtitleContent;
            if (selectedFormat === 'txt') {
                contentToWrite = extractTextFromVtt(subtitleContent);
            } else if (selectedFormat === 'srt') {
                contentToWrite = convertVttToSrt(subtitleContent);
            } else if (selectedFormat === 'vtt') {
                // Đảm bảo nội dung VTT được định dạng đúng
                if (subtitleContent.includes('<?xml') || subtitleContent.includes('<transcript>')) {
                    contentToWrite = convertXmlToVtt(subtitleContent);
                } else if (!subtitleContent.includes('WEBVTT')) {
                    contentToWrite = `WEBVTT\n\n${subtitleContent}`;
                }
            } else {
                throw new Error('Định dạng không được hỗ trợ. Chỉ hỗ trợ: srt, vtt, txt.');
            }

            if (!contentToWrite || contentToWrite.trim() === '') {
                throw new Error(`Không thể tạo file phụ đề ${selectedFormat.toUpperCase()}. Nội dung sau khi chuyển đổi rỗng.`);
            }

            const fileName = `${videoTitle}_${finalSelectedLanguage}.${selectedFormat}`;
            const filePath = path.join(subtitlesDir, fileName);
            await fsPromises.writeFile(filePath, contentToWrite);

            res.status(200).json({ 
                success: true, 
                downloadUrl: `/subtitles/${encodeURIComponent(fileName)}`, 
                selectedLanguage: finalSelectedLanguage,
                availableLanguages: availability.availableLanguages
            });
        } else {
            // Xử lý các nền tảng khác...
            // ... existing code ...
        }
    } catch (error) {
        logger.error(`Subtitle Download Error: ${error.message}`);
        if (error.code === 'RATE_LIMITER_POINTS_EXCEEDED') {
            return res.status(429).json({ error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau vài giây!' });
        }
        return res.status(500).json({ error: error.message || 'Lỗi server khi tải phụ đề. Vui lòng thử lại sau!' });
    }
});

// Endpoint tải tất cả phụ đề (hỗ trợ phụ đề kép)
app.post('/api/download-all-subtitles', async (req, res) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        logger.warn(`Invalid request body from IP: ${req.ip}`);
        return res.status(400).json({ error: 'Body yêu cầu không hợp lệ hoặc thiếu dữ liệu. Vui lòng gửi JSON với trường url.' });
    }

    const { url } = req.body;

    if (!url) {
        logger.warn(`Missing required field (url) from IP: ${req.ip}`);
        return res.status(400).json({ error: 'Thiếu thông tin cần thiết (url)' });
    }

    try {
        await subtitleRateLimiter.consume(`download_all_subtitles_${req.ip}`, 1);
        logger.info(`Download all subtitles request: URL: ${url}, IP: ${req.ip}`);

        const subtitlesDir = path.join(__dirname, 'subtitles');
        if (!await fsPromises.access(subtitlesDir).then(() => true).catch(() => false)) {
            await fsPromises.mkdir(subtitlesDir, { recursive: true });
        }

        await cleanFolder(subtitlesDir);

        const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?&]+)/)?.[1];
        if (!videoId) {
            logger.warn(`Invalid YouTube URL from IP: ${req.ip}: ${url}`);
            return res.status(400).json({ error: 'URL YouTube không hợp lệ' });
        }

        const availability = await checkVideoAvailability(videoId);
        if (!availability.isAvailable) {
            logger.warn(`Video not available: ${videoId}, reason: ${availability.reason}`);
            return res.status(403).json({ error: availability.reason });
        }

        let subtitleFiles = [];
        let videoTitle = await getVideoTitle(videoId);

        // Lấy danh sách ngôn ngữ phụ đề từ @distube/ytdl-core
        const { manual: manualLanguages, auto: autoLanguages } = await getAvailableSubtitleLanguages(url);
        logger.info(`Available manual languages: ${manualLanguages.join(', ')}`);
        logger.info(`Available auto languages: ${autoLanguages.join(', ')}`);

        const allLanguages = [...new Set([...manualLanguages, ...autoLanguages])];

        if (allLanguages.length === 0) {
            throw new Error('Video không có phụ đề nào khả dụng.');
        }

        // Tải phụ đề từ tất cả ngôn ngữ
        const downloadPromises = allLanguages.map(async (lang) => {
            let subtitleContent = null;
            let selectedLang = lang;

            // Phương pháp 1: Sử dụng @distube/ytdl-core
            try {
                const info = await ytdl.getInfo(url, { timeout: 30000 });
                const captions = info.player_response.captions;
                if (!captions || !captions.playerCaptionsTracklistRenderer) {
                    throw new Error('Video không có phụ đề nào');
                }

                const captionTracks = captions.playerCaptionsTracklistRenderer.captionTracks || [];
                const translationLanguages = captions.playerCaptionsTracklistRenderer.translationLanguages || [];
                const caption = captionTracks.find(track => track.languageCode === lang);
                const autoLang = translationLanguages.find(tLang => tLang.languageCode === lang);

                if (caption) {
                    const captionUrl = caption.baseUrl;
                    const response = await fetchWithRetry(captionUrl, { responseType: 'text' }, 3, 2000);
                    subtitleContent = response.data;
                    selectedLang = lang;
                } else if (autoLang && captionTracks[0]) {
                    const autoCaptionUrl = `${captionTracks[0]?.baseUrl}&tlang=${lang}`;
                    const response = await fetchWithRetry(autoCaptionUrl, { responseType: 'text' }, 3, 2000);
                    subtitleContent = response.data;
                    selectedLang = `${lang}.auto`;
                } else {
                    throw new Error(`Không tìm thấy phụ đề cho ngôn ngữ ${lang}.`);
                }

                if (!subtitleContent || subtitleContent.trim() === '') {
                    throw new Error(`Nội dung phụ đề rỗng từ @distube/ytdl-core cho ngôn ngữ ${lang}.`);
                }
            } catch (ytdlError) {
                logger.error(`@distube/ytdl-core subtitle download failed for lang ${lang}: ${ytdlError.message}`);
            }

            // Phương pháp 2: Sử dụng yt-dlp (dự phòng)
            if (!subtitleContent) {
                try {
                    const tempDir = path.join(__dirname, 'temp');
                    if (!await fsPromises.access(tempDir).then(() => true).catch(() => false)) {
                        await fsPromises.mkdir(tempDir, { recursive: true });
                    }

                    const outputPath = path.join(tempDir, `${videoTitle}.${lang}.vtt`);
                    if (manualLanguages.includes(lang)) {
                        await ytDlp(url, {
                            skipDownload: true,
                            writeSub: true,
                            subLang: lang,
                            subFormat: 'vtt',
                            output: outputPath
                        });
                    } else {
                        await ytDlp(url, {
                            skipDownload: true,
                            writeAutoSub: true,
                            subLang: lang,
                            subFormat: 'vtt',
                            output: outputPath
                        });
                        selectedLang = `${lang}.auto`;
                    }

                    if (await fsPromises.access(outputPath).then(() => true).catch(() => false)) {
                        subtitleContent = await fsPromises.readFile(outputPath, 'utf8');
                        await fsPromises.unlink(outputPath);
                    } else {
                        throw new Error(`Không tìm thấy file phụ đề sau khi tải từ yt-dlp cho ngôn ngữ ${lang}.`);
                    }
                } catch (ytdlpError) {
                    logger.error(`yt-dlp subtitle download failed for lang ${lang}: ${ytdlpError.message}`);
                }
            }

            // Phương pháp 3: Sử dụng youtube-caption-extractor (dự phòng)
            if (!subtitleContent) {
                try {
                    let subtitles = await getYTSubtitles({ videoId, lang });
                    if (!subtitles || subtitles.length === 0) {
                        subtitles = await getYTSubtitles({ videoId, lang, tlang: lang });
                        if (!subtitles || subtitles.length === 0) {
                            throw new Error(`Danh sách phụ đề rỗng từ youtube-caption-extractor cho ngôn ngữ ${lang}.`);
                        }
                        selectedLang = `${lang}.auto`;
                    }
                    subtitleContent = arrayToVtt(subtitles);
                } catch (ytError) {
                    logger.error(`youtube-caption-extractor Error for lang ${lang}: ${ytError.message}`);
                    return [];
                }
            }

            if (!subtitleContent || subtitleContent.trim() === '') return [];

            const formats = ['srt', 'vtt', 'txt'];
            const formatPromises = formats.map(async (format) => {
                let content = subtitleContent;
                if (format === 'txt') {
                    content = extractTextFromVtt(content);
                } else if (format === 'srt') {
                    content = convertVttToSrt(content);
                }
                if (!content || content.trim() === '') return null;

                const fileName = `${videoTitle}_${selectedLang}.${format}`;
                const filePath = path.join(subtitlesDir, fileName);
                await fsPromises.writeFile(filePath, content);
                return { language: selectedLang, format, downloadUrl: `/subtitles/${encodeURIComponent(fileName)}` };
            });

            return (await Promise.all(formatPromises)).filter(item => item !== null);
        });

        const results = await Promise.all(downloadPromises);
        subtitleFiles = results.flat();

        if (subtitleFiles.length === 0) {
            throw new Error('Không thể tải phụ đề từ bất kỳ nguồn nào. Video có thể không có phụ đề hoặc không hỗ trợ ngôn ngữ yêu cầu.');
        }

        res.status(200).json({ success: true, subtitles: subtitleFiles });
    } catch (error) {
        logger.error(`Download All Subtitles Error: ${error.message}`);
        return res.status(500).json({ error: error.message || 'Lỗi server khi tải phụ đề. Vui lòng thử lại sau!' });
    }
});

// Endpoint tải phụ đề (GET) - Thông báo lỗi
app.get('/api/download-subtitle', (req, res) => {
    logger.warn(`Invalid method GET for /api/download-subtitle from IP: ${req.ip}`);
    res.status(405).json({ error: 'Phương thức không được hỗ trợ. Vui lòng sử dụng POST để gửi yêu cầu tới /api/download-subtitle với body chứa url, platform, targetLanguage (tùy chọn), và formatPreference (tùy chọn "srt", "vtt", "txt").' });
});

// Endpoint tải tất cả phụ đề (GET) - Thông báo lỗi
app.get('/api/download-all-subtitles', (req, res) => {
    logger.warn(`Invalid method GET for /api/download-all-subtitles from IP: ${req.ip}`);
    res.status(405).json({ error: 'Phương thức không được hỗ trợ. Vui lòng sử dụng POST để gửi yêu cầu tới /api/download-all-subtitles với body chứa url.' });
});

// Cung cấp file phụ đề
app.get('/subtitles/:file', async (req, res) => {
    const fileName = decodeURIComponent(req.params.file);
    const filePath = path.join(__dirname, 'subtitles', fileName);
    logger.info(`Yêu cầu tải phụ đề: ${filePath}`);
    try {
        await fsPromises.access(filePath);
        const stats = await fsPromises.stat(filePath);
        if (stats.size === 0) {
            logger.error(`File phụ đề rỗng: ${filePath}`);
            await fsPromises.unlink(filePath);
            if (!res.headersSent) {
                return res.status(500).json({ error: 'File phụ đề rỗng. Vui lòng thử lại.' });
            }
        }
        res.download(filePath, fileName, (err) => {
            if (err) {
                logger.error(`Lỗi khi gửi file phụ đề ${fileName}: ${err.message}`);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Lỗi khi gửi file phụ đề.' });
                }
            }
        });
    } catch (error) {
        logger.error(`File phụ đề không tìm thấy: ${filePath}`);
        if (!res.headersSent) {
            res.status(404).json({ error: 'File phụ đề không tìm thấy.' });
        }
    }
});

// Cung cấp file tải về (video/âm thanh)
app.get('/downloads/:file', async (req, res) => {
    try {
        const fileName = decodeURIComponent(req.params.file);
        const filePath = path.join(__dirname, 'downloads', fileName);
        logger.info(`Yêu cầu tải file: ${filePath}`);

        await fsPromises.access(filePath);
        const stats = await fsPromises.stat(filePath);
        if (stats.size === 0) {
            logger.error(`File tải về rỗng: ${filePath}`);
            await fsPromises.unlink(filePath);
            if (!res.headersSent) {
                return res.status(500).json({ error: 'File tải về rỗng. Vui lòng thử lại.' });
            }
        }

        res.setTimeout(600000);
        res.download(filePath, fileName, (err) => {
            if (err) {
                logger.error(`Lỗi khi gửi file ${fileName}: ${err.message}`);
                if (err.code === 'EPIPE' || err.message.includes('Request aborted')) {
                    logger.info('Client disconnected during file download, ignoring error.');
                } else if (!res.headersSent) {
                    res.status(500).json({ error: 'Lỗi khi gửi file.' });
                }
            }
        });
    } catch (error) {
        logger.error(`File không tìm thấy: ${error.message}`);
        if (!res.headersSent) {
            res.status(404).json({ error: 'File tải về không tìm thấy.' });
        }
    }
});

// Hàm chuyển đổi VTT sang SRT
function convertVttToSrt(vttText) {
    if (!vttText || vttText.trim() === '') {
        logger.error('Empty VTT content for SRT conversion');
        return null;
    }

    try {
        // Kiểm tra nếu là XML
        if (vttText.includes('<?xml') || vttText.includes('<transcript>')) {
            vttText = convertXmlToVtt(vttText);
            if (!vttText) {
                throw new Error('Failed to convert XML to VTT');
            }
        }

        const lines = vttText.split('\n');
        let srtText = '';
        let index = 1;
        let i = 0;

        // Bỏ qua header WEBVTT và các dòng trống đầu tiên
        while (i < lines.length && (lines[i].startsWith('WEBVTT') || lines[i].trim() === '')) {
            i++;
        }

        while (i < lines.length) {
            if (lines[i].match(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/)) {
                // Chuyển đổi timestamp từ VTT sang SRT
                const timestamp = lines[i]
                    .replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2')
                    .replace(' --> ', ' --> ')
                    .replace(/\.\d+$/, ''); // Loại bỏ phần thập phân dư thừa
                
                srtText += `${index}\n${timestamp}\n`;
                i++;

                // Lấy nội dung phụ đề
                let subtitleText = '';
                while (i < lines.length && lines[i].trim() !== '') {
                    let cleanLine = lines[i]
                        .replace(/<[^>]+>/g, '')
                        .replace(/align:start/g, '')
                        .replace(/position:\d+%/g, '')
                        .replace(/\d{2}:\d{2}:\d{2}\.\d{3}/g, '')
                        .replace(/<c>/g, '')
                        .replace(/<\/c>/g, '')
                        .replace(/&nbsp;/g, ' ')
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&quot;/g, '"')
                        .replace(/&#39;/g, "'")
                        .replace(/\u200B/g, '')
                        .replace(/\u200C/g, '')
                        .replace(/\u200D/g, '')
                        .replace(/\u200E/g, '')
                        .replace(/\u200F/g, '')
                        .trim();

                    if (cleanLine) {
                        subtitleText += (subtitleText ? '\n' : '') + cleanLine;
                    }
                    i++;
                }

                if (subtitleText) {
                    const truncatedText = truncateSubtitleText(subtitleText);
                    srtText += `${truncatedText}\n\n`;
                    index++;
                }
            } else {
                i++;
            }
        }

        const result = srtText.trim();
        if (result === '') {
            logger.error('Empty SRT content after conversion');
            return null;
        }

        return result;
    } catch (error) {
        logger.error(`VTT to SRT conversion failed: ${error.message}`, {
            error: error.stack,
            vttContent: vttText
        });
        return null;
    }
}

app.listen(port, () => {
    logger.info(`Server running on port ${port}, OS: ${os.platform()}, Node.js version: ${process.version}`);
});