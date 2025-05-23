const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const winston = require('winston');
const ffmpeg = require('fluent-ffmpeg');
const ytdl = require('@distube/ytdl-core');
const ytDlp = require('yt-dlp');

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

// Hàm gọi API với retry mechanism
async function fetchWithRetry(url, options, retries = 5, delay = 2000) {
    for (let i = 0; i <= retries; i++) {
        try {
            const response = await axios(url, { ...options, timeout: 60000 });
            return response;
        } catch (error) {
            logger.warn(`Retry ${i + 1}/${retries + 1} failed for ${url}: ${error.message}`);
            if (i === retries) throw error;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Hàm kiểm tra tính khả dụng của FFmpeg
async function checkFFmpeg() {
    return new Promise((resolve) => {
        require('child_process').exec('ffmpeg -version', (err, stdout, stderr) => {
            if (err || stderr.includes('error')) {
                logger.error('FFmpeg is not installed or accessible');
                resolve(false);
            } else {
                resolve(true);
            }
        });
    });
}

// Hàm kiểm tra tính toàn vẹn của file
async function validateFile(filePath, type) {
    try {
        return new Promise((resolve) => {
            ffmpeg.ffprobe(filePath, (err, metadata) => {
                if (err) {
                    logger.error(`File không hợp lệ (ffprobe error): ${filePath}, error: ${err.message}`);
                    resolve(false);
                    return;
                }

                if (!metadata || !metadata.format || !metadata.streams) {
                    logger.error(`File không hợp lệ (metadata missing): ${filePath}`);
                    resolve(false);
                    return;
                }

                if (type === 'video') {
                    const hasVideo = metadata.streams.some(stream => stream.codec_type === 'video');
                    const hasAudio = metadata.streams.some(stream => stream.codec_type === 'audio');
                    if (!hasVideo || !hasAudio) {
                        logger.error(`File video không hợp lệ (thiếu video hoặc audio stream): ${filePath}`);
                        resolve(false);
                        return;
                    }
                } else if (type === 'audio') {
                    const hasAudio = metadata.streams.some(stream => stream.codec_type === 'audio');
                    if (!hasAudio) {
                        logger.error(`File audio không hợp lệ (thiếu audio stream): ${filePath}`);
                        resolve(false);
                        return;
                    }
                }

                resolve(true);
            });
        });
    } catch (error) {
        logger.error(`Error validating file ${filePath}: ${error.message}`);
        return false;
    }
}

// Hàm xóa file cũ nhất nếu vượt quá giới hạn
async function cleanFolder(folderPath, maxFiles = 10) {
    try {
        const exists = await fs.access(folderPath).then(() => true).catch(() => false);
        if (!exists) return;

        const files = await fs.readdir(folderPath);
        const fileStats = [];

        for (const file of files) {
            const filePath = path.join(folderPath, file);
            const stats = await fs.stat(filePath);
            if (stats.isFile()) {
                fileStats.push({ file, mtimeMs: stats.mtimeMs });
            }
        }

        if (fileStats.length > maxFiles) {
            fileStats.sort((a, b) => a.mtimeMs - b.mtimeMs);
            const fileToDelete = path.join(folderPath, fileStats[0].file);
            logger.info(`Chuẩn bị xóa file cũ nhất: ${fileToDelete}`);
            await fs.unlink(fileToDelete);
            logger.info(`Đã xóa file cũ nhất: ${fileToDelete}`);
        }
    } catch (error) {
        logger.error(`Error cleaning folder ${folderPath}: ${error.message}`);
    }
}

// Hàm xử lý tiêu đề thành tên file hợp lệ
function sanitizeFileName(title) {
    return title
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[<>:"\/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/\.+/g, '.')
        .replace(/^\.+|\.+$/g, '')
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
function truncateSubtitleText(text) {
    if (!text) return '';
    return text.trim();
}

// Hàm chuyển đổi phụ đề sang VTT
function arrayToVtt(subtitles) {
    if (!subtitles || subtitles.length === 0) return null;
    let vtt = '';
    subtitles.forEach((sub) => {
        const start = sub.startMs ? msToTime(sub.startMs) : msToTime(sub.start * 1000);
        const end = sub.startMs ? msToTime(sub.startMs + sub.durationMs) : msToTime(sub.end * 1000);
        const text = sub.subtitle || sub.text;
        if (text && text.trim()) {
            const truncatedText = truncateSubtitleText(text);
            vtt += `${start} --> ${end}\n${truncatedText}\n\n`;
        }
    });
    return vtt.trim() === '' ? null : vtt.trim();
}

// Hàm chuyển đổi phụ đề sang SRT
function arrayToSrt(subtitles) {
    if (!subtitles || subtitles.length === 0) return null;
    let srt = '';
    subtitles.forEach((sub) => {
        const start = sub.startMs ? msToTimeSrt(sub.startMs) : msToTimeSrt(sub.start * 1000);
        const end = sub.startMs ? msToTimeSrt(sub.startMs + sub.durationMs) : msToTimeSrt(sub.end * 1000);
        const text = sub.subtitle || sub.text;
        if (text && text.trim()) {
            const truncatedText = truncateSubtitleText(text);
            srt += `${start} --> ${end}\n${truncatedText}\n\n`;
        }
    });
    return srt.trim() === '' ? null : srt.trim();
}

// Hàm chuyển đổi phụ đề sang XML
function arrayToXml(subtitles) {
    if (!subtitles || subtitles.length === 0) return null;
    let xml = '';
    subtitles.forEach((sub) => {
        const start = sub.startMs ? msToTime(sub.startMs) : msToTime(sub.start * 1000);
        const end = sub.startMs ? msToTime(sub.startMs + sub.durationMs) : msToTime(sub.end * 1000);
        const text = sub.subtitle || sub.text;
        if (text && text.trim()) {
            const truncatedText = truncateSubtitleText(text);
            xml += `${start} --> ${end}\n${truncatedText}\n\n`;
        }
    });
    return xml.trim() === '' ? null : xml.trim();
}

// Hàm chuyển đổi phụ đề sang TXT
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
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const milliseconds = ms % 1000;
    return `${pad(hours)}:${pad(minutes % 60)}:${pad(seconds % 60)}.${pad(milliseconds, 3)}`;
}

// Hàm chuyển đổi thời gian từ milliseconds sang định dạng SRT
function msToTimeSrt(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const milliseconds = ms % 1000;
    return `${pad(hours)}:${pad(minutes % 60)}:${pad(seconds % 60)},${pad(milliseconds, 3)}`;
}

// Hàm bổ sung số 0 cho định dạng thời gian
function pad(num, size = 2) {
    return num.toString().padStart(size, '0');
}

// Hàm chuyển đổi VTT sang SRT
function convertVttToSrt(vttText) {
    if (!vttText || vttText.trim() === '') {
        logger.error('Empty VTT content');
        return null;
    }

    let srtText = '';
    const lines = vttText.split('\n');
    let i = 0;
    let subtitleIndex = 1;
    let subtitleCount = 0;

    // Bỏ qua tiêu đề WEBVTT và các dòng trống đầu tiên
    while (i < lines.length && (lines[i].startsWith('WEBVTT') || lines[i].trim() === '')) {
        i++;
    }

    while (i < lines.length) {
        try {
            if (lines[i].match(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/)) {
                const timeLine = lines[i].replace('.', ',');
                i++;
                let subtitleText = '';
                while (i < lines.length && lines[i].trim() !== '') {
                    subtitleText += (subtitleText ? '\n' : '') + lines[i].trim();
                    i++;
                }
                if (subtitleText.trim()) {
                    srtText += `${subtitleIndex}\n${timeLine}\n${subtitleText.trim()}\n\n`;
                    subtitleIndex++;
                    subtitleCount++;
                }
            }
            i++;
        } catch (error) {
            logger.error(`Error converting VTT to SRT at line ${i}: ${error.message}`);
            i++;
        }
    }

    if (subtitleCount === 0) {
        logger.error('No valid subtitles after conversion to SRT');
        return null;
    }

    logger.info(`Converted ${subtitleCount} subtitles to SRT format`);
    return srtText;
}

// Hàm trích xuất văn bản từ VTT thành TXT
function extractTextFromVtt(vttText) {
    if (!vttText || vttText.trim() === '') {
        logger.error('Empty VTT content');
        return null;
    }

    const lines = vttText.split('\n');
    let text = '';
    let i = 0;
    let subtitleCount = 0;

    // Bỏ qua tiêu đề WEBVTT và các dòng trống đầu tiên
    while (i < lines.length && (lines[i].startsWith('WEBVTT') || lines[i].trim() === '')) {
        i++;
    }

    while (i < lines.length) {
        try {
            if (lines[i].match(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/)) {
                i++;
                let subtitleText = '';
                while (i < lines.length && lines[i].trim() !== '') {
                    subtitleText += (subtitleText ? '\n' : '') + lines[i].trim();
                    i++;
                }
                if (subtitleText.trim()) {
                    text += (text ? '\n\n' : '') + subtitleText.trim();
                    subtitleCount++;
                }
            }
            i++;
        } catch (error) {
            logger.error(`Error extracting text from VTT at line ${i}: ${error.message}`);
            i++;
        }
    }

    if (subtitleCount === 0) {
        logger.error('No valid subtitles after extraction to TXT');
        return null;
    }

    logger.info(`Extracted ${subtitleCount} subtitles to TXT format`);
    return text;
}

// Hàm parse XML phụ đề từ YouTube
function parseXmlSubtitles(xmlContent) {
    try {
        const subtitles = [];
        const lines = xmlContent.split('\n');
        let currentSubtitle = null;
        let subtitleCount = 0;

        for (const line of lines) {
            const startMatch = line.match(/start="([^"]+)"/);
            const durMatch = line.match(/dur="([^"]+)"/);
            const textMatch = line.match(/<text[^>]*>(.*?)<\/text>/);

            if (startMatch) {
                if (currentSubtitle && currentSubtitle.text.trim()) {
                    subtitles.push(currentSubtitle);
                    subtitleCount++;
                }
                currentSubtitle = {
                    start: parseFloat(startMatch[1]),
                    duration: durMatch ? parseFloat(durMatch[1]) : 5,
                    text: ''
                };
            }

            if (textMatch && currentSubtitle) {
                const text = textMatch[1].trim();
                if (text) {
                    // Thay thế các ký tự đặc biệt
                    const decodedText = text
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&quot;/g, '"')
                        .replace(/&#39;/g, "'")
                        .replace(/&nbsp;/g, ' ');
                    
                    currentSubtitle.text += (currentSubtitle.text ? ' ' : '') + decodedText;
                }
            }
        }

        if (currentSubtitle && currentSubtitle.text.trim()) {
            subtitles.push(currentSubtitle);
            subtitleCount++;
        }

        logger.info(`Parsed ${subtitleCount} subtitles from XML`);
        return subtitles;
    } catch (error) {
        logger.error(`Error parsing XML subtitles: ${error.message}`);
        return null;
    }
}

// Hàm lấy danh sách ngôn ngữ phụ đề khả dụng
async function getAvailableSubtitleLanguages(url) {
    try {
        // Phương pháp 1: Sử dụng yt-dlp
        try {
            const result = await ytDlp(url, {
                listSubs: true,
                skipDownload: true,
                noCheckCertificates: true,
                noWarnings: true,
                preferFreeFormats: true,
                addHeader: [
                    'referer:youtube.com',
                    'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                ]
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

            if (languages.manual.length > 0 || languages.auto.length > 0) {
                return languages;
            }
        } catch (ytdlpError) {
            logger.error(`yt-dlp subtitle language fetch failed: ${ytdlpError.message}`);
        }

        // Phương pháp 2: Sử dụng @distube/ytdl-core
        try {
            const info = await ytdl.getInfo(url, { 
                timeout: 30000,
                requestOptions: {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        'Accept': '*/*',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Range': 'bytes=0-'
                    }
                }
            });
            const captions = info.player_response.captions;
            if (captions && captions.playerCaptionsTracklistRenderer) {
                const captionTracks = captions.playerCaptionsTracklistRenderer.captionTracks || [];
                const manualLanguages = captionTracks.map(track => track.languageCode);

                const translationLanguages = captions.playerCaptionsTracklistRenderer.translationLanguages || [];
                const autoLanguages = translationLanguages.map(lang => lang.languageCode);

                return { manual: manualLanguages, auto: autoLanguages };
            }
        } catch (ytdlError) {
            logger.error(`@distube/ytdl-core subtitle language fetch failed: ${ytdlError.message}`);
        }

        // Phương pháp 3: Sử dụng YouTube API
        try {
            const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?&]+)/)?.[1];
            if (videoId) {
                const response = await fetchWithRetry(`https://www.googleapis.com/youtube/v3/captions`, {
                    params: {
                        part: 'snippet',
                        videoId: videoId,
                        key: process.env.YOUTUBE_API_KEY
                    }
                });
                const items = response.data.items || [];
                const languages = { manual: [], auto: [] };
                items.forEach(item => {
                    const langCode = item.snippet.language;
                    if (item.snippet.trackKind === 'ASR') {
                        languages.auto.push(langCode);
                    } else {
                        languages.manual.push(langCode);
                    }
                });
                if (languages.manual.length > 0 || languages.auto.length > 0) {
                    return languages;
                }
            }
        } catch (apiError) {
            logger.error(`YouTube API subtitle language fetch failed: ${apiError.message}`);
        }

        // Phương pháp 4: Sử dụng node-youtube-subtitles
        try {
            const { getSubtitles } = require('node-youtube-subtitles');
            const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?&]+)/)?.[1];
            if (videoId) {
                const subtitles = await getSubtitles({ videoID: videoId });
                if (subtitles && subtitles.length > 0) {
                    return { manual: ['en'], auto: [] };
                }
            }
        } catch (nodeError) {
            logger.error(`node-youtube-subtitles subtitle language fetch failed: ${nodeError.message}`);
        }

        return { manual: [], auto: [] };
    } catch (error) {
        logger.error(`Error getting available subtitle languages: ${error.message}`);
        return { manual: [], auto: [] };
    }
}

// Hàm trả về ngôn ngữ mặc định cố định
function getDefaultLanguage() {
    return 'en'; // Ngôn ngữ mặc định cố định là tiếng Anh
}

// Xuất khẩu các hàm
module.exports = {
    logger,
    fetchWithRetry,
    checkFFmpeg,
    validateFile,
    cleanFolder,
    sanitizeFileName,
    checkVideoAvailability,
    getVideoTitle,
    truncateSubtitleText,
    arrayToVtt,
    arrayToSrt,
    arrayToXml,
    arrayToTxt,
    msToTime,
    msToTimeSrt,
    pad,
    convertVttToSrt,
    extractTextFromVtt,
    parseXmlSubtitles,
    getAvailableSubtitleLanguages,
    getDefaultLanguage
};