require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ytdl = require('ytdl-core');
const { exec } = require('child_process');
const rateLimit = require('express-rate-limit');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json({
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

// Middleware xử lý CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    next();
});

// Rate Limiter cho tải file
const downloadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 phút
    max: 5 // Giới hạn 5 yêu cầu mỗi IP
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

// Hàm kiểm tra danh sách định dạng để chọn định dạng khả dụng
async function getAvailableFormats(videoUrl) {
    console.log(`Fetching formats for URL: ${videoUrl}`);
    try {
        const info = await ytdl.getInfo(videoUrl);
        const formats = info.formats;
        return formats.map(format => ({
            itag: format.itag,
            quality: format.qualityLabel || format.audioBitrate,
            container: format.container,
            type: format.mimeType.includes('video') ? 'video' : 'audio'
        }));
    } catch (error) {
        console.error('Error in getAvailableFormats with ytdl-core:', error.message);
        if (error.message.includes('Status code: 410')) {
            console.warn('ytdl-core failed with 410, falling back to yt-dlp...');
            try {
                const command = `yt-dlp --list-formats "${videoUrl}"`;
                const result = await new Promise((resolve, reject) => {
                    exec(command, { maxBuffer: 1024 * 1024 * 10, timeout: 10000 }, (err, stdout, stderr) => {
                        if (err) {
                            console.error('Error fetching formats with yt-dlp:', stderr);
                            reject(new Error('Không thể lấy danh sách định dạng bằng yt-dlp: ' + stderr));
                        } else {
                            resolve(stdout);
                        }
                    });
                });
                return result.split('\n').filter(line => line.includes('format code') || line.trim().match(/\d+\s/)).map(line => {
                    const match = line.trim().match(/\d+\s/);
                    if (match) {
                        const itag = match[0].trim();
                        return { itag, quality: line.includes('video') ? line.split(' ')[2] : 'audio', type: line.includes('video') ? 'video' : 'audio' };
                    }
                    return null;
                }).filter(f => f);
            } catch (ytDlpError) {
                console.error('Error in yt-dlp fallback:', ytDlpError.message);
                return [];
            }
        }
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
            console.log(`Chuẩn bị xóa file cũ nhất: ${fileToDelete}`);
            await fs.unlink(fileToDelete);
            console.log(`Đã xóa file cũ nhất: ${fileToDelete}`);
        }
    } catch (error) {
        console.error(`Error cleaning folder ${folderPath}:`, error.message);
    }
}

// Hàm xử lý tiêu đề thành tên file hợp lệ
function sanitizeFileName(title) {
    return title
        .replace(/[\/\\:*\?"<>|()]/g, '_')
        .replace(/\s+/g, '_')
        .substring(0, 50)
        .trim();
}

// Hàm kiểm tra tính khả dụng của video YouTube
async function checkVideoAvailability(videoId) {
    try {
        const response = await axios.get(`https://www.googleapis.com/youtube/v3/videos`, {
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
        console.error('Error checking video availability:', error.message);
        return { isAvailable: false, reason: 'Không thể kiểm tra tính khả dụng của video.' };
    }
}

// Endpoint metadata
app.post('/api/metadata', async (req, res) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        return res.status(400).json({ error: 'Body yêu cầu không hợp lệ hoặc thiếu dữ liệu. Vui lòng gửi JSON với các trường url và platform.' });
    }

    const { url, platform } = req.body;

    if (!url || !platform) {
        return res.status(400).json({ error: 'Thiếu thông tin cần thiết (url, platform)' });
    }

    try {
        let metadata = { thumbnail: '', title: '' };

        if (platform === 'youtube') {
            const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?&]+)/)?.[1];
            if (videoId) {
                const youtubeResponse = await axios.get(`https://www.googleapis.com/youtube/v3/videos`, {
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
                const rapidApiResponse = await axios.post('https://all-media-downloader1.p.rapidapi.com/media', { url }, {
                    headers: {
                        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
                        'x-rapidapi-host': 'all-media-downloader1.p.rapidapi.com',
                        'Content-Type': 'application/json'
                    },
                    timeout: 20000
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
                console.error('RapidAPI Metadata Error:', rapidError.response ? rapidError.response.data : rapidError.message);
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
        console.error('Metadata Error:', error.response ? error.response.data : error.message);
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
        return res.status(400).json({ error: 'Body yêu cầu không hợp lệ hoặc thiếu dữ liệu. Vui lòng gửi JSON với các trường url, platform, type.' });
    }

    const { url, platform, type, quality } = req.body;

    if (!url || !platform || !type) {
        return res.status(400).json({ error: 'Thiếu thông tin cần thiết (url, platform, type)' });
    }

    try {
        await rateLimiter.consume('download_endpoint', 1);

        // Kiểm tra yt-dlp
        const ytDlpCheck = await new Promise((resolve, reject) => {
            exec('yt-dlp --version', { timeout: 5000 }, (err) => resolve(!err));
        });
        if (!ytDlpCheck) {
            return res.status(500).json({ error: 'yt-dlp không được cài đặt. Vui lòng cài yt-dlp (sudo apt install yt-dlp) và thử lại.' });
        }

        const ffmpegCheck = await new Promise((resolve, reject) => {
            exec('ffmpeg -version', { timeout: 5000 }, (err) => resolve(!err));
        });
        if (!ffmpegCheck) {
            return res.status(500).json({ error: 'FFmpeg không được cài đặt. Vui lòng cài FFmpeg (sudo apt install ffmpeg) và thử lại.' });
        }

        if (platform === 'youtube') {
            const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?&]+)/)?.[1];
            if (!videoId) {
                return res.status(400).json({ error: 'URL YouTube không hợp lệ' });
            }

            const availability = await checkVideoAvailability(videoId);
            if (!availability.isAvailable) {
                return res.status(403).json({ error: availability.reason });
            }

            let videoTitle;
            try {
                const youtubeResponse = await axios.get(`https://www.googleapis.com/youtube/v3/videos`, {
                    params: {
                        part: 'snippet',
                        id: videoId,
                        key: process.env.YOUTUBE_API_KEY
                    }
                });
                const item = youtubeResponse.data.items[0];
                if (item) {
                    videoTitle = sanitizeFileName(item.snippet.title);
                } else {
                    videoTitle = `Video_YouTube_${videoId}`;
                }
            } catch (error) {
                console.error('Error fetching video title:', error.message);
                videoTitle = `Video_YouTube_${videoId}`;
            }

            const fileExtension = type === 'video' ? 'mp4' : 'mp3';
            const fileName = `${videoTitle}${quality ? `_${quality}` : ''}.${fileExtension}`;
            const filePath = path.join(__dirname, 'downloads', fileName).replace(/ /g, '\\ '); // Thoát khoảng trắng

            if (!await fs.access(path.join(__dirname, 'downloads')).then(() => true).catch(() => false)) {
                await fs.mkdir(path.join(__dirname, 'downloads'), { recursive: true });
            }

            await cleanFolder(path.join(__dirname, 'downloads'));

            if (await fs.access(filePath).then(() => true).catch(() => false)) {
                console.log(`File đã tồn tại: ${filePath}`);
                return res.status(200).json({ success: true, downloadUrl: `/downloads/${encodeURIComponent(fileName)}` });
            }

            // Chọn định dạng khả dụng
            const selectedItag = await selectAvailableFormat(url, quality, type);
            if (!selectedItag) {
                return res.status(400).json({ error: 'Không tìm thấy định dạng khả dụng.' });
            }

            const args = [
                url,
                '--output', filePath,
                ...(type === 'video' 
                    ? ['--merge-output-format', 'mp4', '--format', selectedItag] 
                    : ['--extract-audio', '--audio-format', 'mp3', '--format', selectedItag]),
                '--no-part',
                '--retries', '5',
                '--fragment-retries', '5',
            ];

            if (type === 'video' && !selectedItag.toString().includes('+')) {
                args.push('--recode-video', 'mp4');
            }

            const ytDlpCommand = ['yt-dlp'].concat(args).join(' ');
            console.log('Executing yt-dlp command:', ytDlpCommand);

            await new Promise((resolve, reject) => {
                exec(ytDlpCommand, { maxBuffer: 1024 * 1024 * 50, timeout: 300000 }, (err, stdout, stderr) => {
                    if (err) {
                        console.error('yt-dlp stderr:', stderr);
                        if (stderr.includes("ENOENT")) {
                            reject(new Error('yt-dlp không được tìm thấy. Vui lòng cài yt-dlp hệ thống (sudo apt install yt-dlp) và thử lại.'));
                        } else if (stderr.includes("ffmpeg")) {
                            reject(new Error('FFmpeg không được cài đặt. Vui lòng cài FFmpeg (sudo apt install ffmpeg) và thử lại.'));
                        } else if (stderr.includes("video unavailable")) {
                            reject(new Error('Video không khả dụng hoặc bị giới hạn khu vực. Vui lòng thử video khác.'));
                        } else if (stderr.includes("HTTP Error 403")) {
                            reject(new Error('Lỗi HTTP 403: Truy cập bị từ chối. Video có thể bị bảo vệ DRM.'));
                        } else if (stderr.includes("Requested format is not available")) {
                            reject(new Error('Format yêu cầu không khả dụng. Đã thử chọn định dạng khác, vui lòng thử lại.'));
                        } else if (stderr.includes("DRM protected")) {
                            reject(new Error('Video bị bảo vệ DRM. Vui lòng thử video khác không có bảo vệ bản quyền.'));
                        } else if (stderr.includes("SABR streaming")) {
                            reject(new Error('YouTube áp dụng SABR streaming, một số định dạng không khả dụng. Đã thử định dạng thay thế, vui lòng thử video khác.'));
                        } else if (stderr.includes("Postprocessing")) {
                            reject(new Error('Lỗi postprocessing: Stream không tương thích. Vui lòng kiểm tra phiên bản FFmpeg.'));
                        } else if (err.code === 'ETIMEDOUT') {
                            reject(new Error('Yêu cầu tải nội dung hết thời gian. Vui lòng thử lại với mạng ổn định hơn.'));
                        } else if (stderr.includes("Syntax error")) {
                            reject(new Error('Lỗi cú pháp trong lệnh. Đã xử lý, vui lòng thử lại.'));
                        }
                        reject(new Error('Không thể tải nội dung: ' + stderr));
                    } else {
                        console.log('yt-dlp stdout:', stdout);
                        resolve();
                    }
                });
            });

            if (!await fs.access(filePath).then(() => true).catch(() => false)) {
                return res.status(500).json({ error: 'Tải xuống thất bại. File không được tạo.' });
            }

            const stats = await fs.stat(filePath);
            if (stats.size === 0) {
                console.error(`File tải về rỗng: ${filePath}`);
                await fs.unlink(filePath);
                return res.status(500).json({ error: 'File tải về rỗng. Vui lòng thử lại.' });
            }

            console.log(`File tải về thành công: ${filePath}, kích thước: ${stats.size} bytes`);
            return res.status(200).json({ success: true, downloadUrl: `/downloads/${encodeURIComponent(fileName)}` });
        } else {
            try {
                const response = await axios.post('https://all-media-downloader1.p.rapidapi.com/media', { url, quality }, {
                    headers: {
                        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
                        'x-rapidapi-host': 'all-media-downloader1.p.rapidapi.com',
                        'Content-Type': 'application/json'
                    },
                    timeout: 20000
                });

                const data = response.data;
                if (data.error) {
                    return res.status(400).json({ error: data.error });
                }

                if (type === 'video' && data.video) {
                    return res.status(200).json({ downloadUrl: data.video });
                } else if (type === 'audio' && data.audio) {
                    return res.status(200).json({ downloadUrl: data.audio });
                } else {
                    return res.status(400).json({ error: 'Không tìm thấy nội dung để tải' });
                }
            } catch (rapidError) {
                console.error('RapidAPI Download Error:', rapidError.response ? rapidError.response.data : rapidError.message);
                return res.status(rapidError.response?.status || 500).json({ error: 'Lỗi từ API tải nội dung khác' });
            }
        }
    } catch (error) {
        console.error('API Error:', error.message);
        if (error.code === 'ECONNABORTED') {
            return res.status(504).json({ error: 'Yêu cầu tải nội dung hết thời gian. Vui lòng thử lại!' });
        } else if (error.code === 'RATE_LIMITER_POINTS_EXCEEDED') {
            return res.status(429).json({ error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau!' });
        }
        return res.status(500).json({ error: error.message || 'Lỗi server khi tải nội dung. Vui lòng thử lại sau!' });
    }
});

// Endpoint tải phụ đề
app.post('/api/download-subtitle', async (req, res) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        return res.status(400).json({ error: 'Body yêu cầu không hợp lệ hoặc thiếu dữ liệu. Vui lòng gửi JSON với các trường url, platform, targetLanguage (mặc định "en"), và formatPreference (mặc định "srt").' });
    }

    const { url, platform, targetLanguage = 'en', formatPreference = 'srt' } = req.body;

    if (!url || !platform) {
        return res.status(400).json({ error: 'Thiếu thông tin cần thiết (url, platform)' });
    }

    try {
        await subtitleRateLimiter.consume(`download_subtitle_${req.ip}`, 1);

        const subtitlesDir = path.join(__dirname, 'subtitles');
        if (!await fs.access(subtitlesDir).then(() => true).catch(() => false)) {
            await fs.mkdir(subtitlesDir, { recursive: true });
        }

        await cleanFolder(subtitlesDir);

        let subtitleUrl = '';
        let selectedLanguage = targetLanguage;

        if (platform === 'youtube') {
            const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?&]+)/)?.[1];
            if (!videoId) {
                return res.status(400).json({ error: 'URL YouTube không hợp lệ' });
            }

            let subtitleContent = null;
            try {
                const info = await ytdl.getInfo(url);
                const captions = info.player_response.captions;
                if (!captions || !captions.playerCaptionsTracklistRenderer) {
                    throw new Error('Video không có phụ đề nào');
                }

                const captionTracks = captions.playerCaptionsTracklistRenderer.captionTracks;
                const caption = captionTracks.find(track => track.languageCode === targetLanguage);
                if (!caption) {
                    selectedLanguage = captionTracks[0]?.languageCode || 'en';
                    const fallbackCaption = captionTracks[0];
                    if (!fallbackCaption) {
                        throw new Error(`Không tìm thấy phụ đề cho ngôn ngữ ${targetLanguage}`);
                    }
                    const captionUrl = fallbackCaption.baseUrl;
                    const response = await axios.get(captionUrl, { responseType: 'text' });
                    subtitleContent = response.data;
                } else {
                    const captionUrl = caption.baseUrl;
                    const response = await axios.get(captionUrl, { responseType: 'text' });
                    subtitleContent = response.data;
                }
            } catch (ytdlError) {
                console.error('ytdl-core Error:', ytdlError.message);
                if (ytdlError.message.includes('Status code: 410')) {
                    throw new Error('Không thể tải phụ đề do YouTube trả về mã 410. Vui lòng thử video khác hoặc kiểm tra kết nối.');
                }
                if (ytdlError.message.includes('Could not extract functions')) {
                    throw new Error('Không thể tải phụ đề do lỗi phân tích cú pháp từ YouTube. Vui lòng thử video khác.');
                }
                throw ytdlError;
            }

            let format = formatPreference.toLowerCase();
            if (format === 'txt') {
                subtitleContent = subtitleContent.replace(/WEBVTT\n\n|^\d+\n\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\n/g, '').trim();
            } else if (format === 'srt') {
                subtitleContent = convertVttToSrt(subtitleContent);
            }

            const fileName = `subtitle_${videoId}_${selectedLanguage}.${format}`;
            const filePath = path.join(subtitlesDir, fileName);
            await fs.writeFile(filePath, subtitleContent);

            subtitleUrl = `/subtitles/${encodeURIComponent(fileName)}`;
        } else {
            const response = await axios.post('https://all-media-downloader1.p.rapidapi.com/media', {
                url,
                language: targetLanguage,
                format: formatPreference
            }, {
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPI_KEY,
                    'x-rapidapi-host': 'all-media-downloader1.p.rapidapi.com',
                    'Content-Type': 'application/json'
                },
                timeout: 20000
            });

            const data = response.data;
            if (data.error || !data.subtitle) {
                return res.status(404).json({ error: data.error || 'RapidAPI không hỗ trợ trích xuất phụ đề cho nền tảng này' });
            }

            const fileName = `subtitle_${targetLanguage || 'en'}_${uuidv4()}.${formatPreference}`;
            const filePath = path.join(subtitlesDir, fileName);
            await fs.writeFile(filePath, data.subtitle);

            subtitleUrl = `/subtitles/${encodeURIComponent(fileName)}`;
        }

        res.status(200).json({ success: true, downloadUrl: subtitleUrl, selectedLanguage });
    } catch (error) {
        console.error('Subtitle Download Error:', error.message);
        if (error.code === 'RATE_LIMITER_POINTS_EXCEEDED') {
            return res.status(429).json({ error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau vài giây!' });
        }
        if (error.response) {
            return res.status(error.response.status).json({ error: error.response.data?.error?.message || error.message || 'Lỗi từ API tải phụ đề' });
        } else if (error.code === 'ECONNABORTED') {
            return res.status(504).json({ error: 'Yêu cầu tải phụ đề hết thời gian. Vui lòng thử lại!' });
        } else {
            return res.status(500).json({ error: error.message || 'Lỗi server khi tải phụ đề. Vui lòng thử lại sau!' });
        }
    }
});

// Hàm chuyển đổi VTT sang SRT
function convertVttToSrt(vttText) {
    let srtText = vttText
        .replace(/WEBVTT\n\n/, '')
        .replace(/(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})/g, (match, start, end, index) => {
            return `${index + 1}\n${start.replace('.', ',')} --> ${end.replace('.', ',')}\n`;
        });
    return srtText.trim();
}

// Endpoint tải phụ đề (GET) - Thông báo lỗi
app.get('/api/download-subtitle', (req, res) => {
    res.status(405).json({ error: 'Phương thức không được hỗ trợ. Vui lòng sử dụng POST để gửi yêu cầu tới /api/download-subtitle với body chứa url, platform, targetLanguage (mặc định "en"), và formatPreference (mặc định "srt").' });
});

// Cung cấp file phụ đề
app.get('/subtitles/:file', async (req, res) => {
    const fileName = decodeURIComponent(req.params.file);
    const filePath = path.join(__dirname, 'subtitles', fileName);
    console.log(`Yêu cầu tải phụ đề: ${filePath}`);
    try {
        await fs.access(filePath);
        res.download(filePath, fileName, (err) => {
            if (err) {
                console.error(`Lỗi khi gửi file phụ đề ${fileName}:`, err.message);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Lỗi khi gửi file phụ đề.' });
                }
            }
        });
    } catch (error) {
        console.error(`File phụ đề không tìm thấy: ${filePath}`);
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
        console.log(`Yêu cầu tải file: ${filePath}`);

        await fs.access(filePath);
        const stats = await fs.stat(filePath);
        if (stats.size === 0) {
            console.error(`File tải về rỗng: ${filePath}`);
            await fs.unlink(filePath);
            if (!res.headersSent) {
                return res.status(500).json({ error: 'File tải về rỗng. Vui lòng thử lại.' });
            }
        }

        res.setTimeout(300000); // 5 phút
        res.download(filePath, fileName, (err) => {
            if (err) {
                console.error(`Lỗi khi gửi file ${fileName}:`, err.message);
                if (err.code === 'EPIPE' || err.message.includes('Request aborted')) {
                    console.log('Client disconnected during file download, ignoring error.');
                } else if (!res.headersSent) {
                    res.status(500).json({ error: 'Lỗi khi gửi file.' });
                }
            }
        });
    } catch (error) {
        console.error(`File không tìm thấy: ${error.message}`);
        if (!res.headersSent) {
            res.status(404).json({ error: 'File tải về không tìm thấy.' });
        }
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});