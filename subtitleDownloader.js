// subtitleDownloader.js
const { RateLimiterMemory } = require('rate-limiter-flexible');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ytdl = require('@distube/ytdl-core');
const ytDlp = require('yt-dlp-exec');
const {
    logger,
    fetchWithRetry,
    cleanFolder,
    sanitizeFileName,
    getVideoTitle,
    arrayToVtt,
    convertVttToSrt,
    extractTextFromVtt,
    getAvailableSubtitleLanguages,
    checkVideoAvailability,
    getDefaultLanguage
} = require('./utils');

// Rate Limiter cho tải phụ đề: Giới hạn 5 request/giây
const subtitleRateLimiter = new RateLimiterMemory({
    points: 5,
    duration: 1,
});

// Danh sách để theo dõi các yêu cầu tải phụ đề đang xử lý
const activeSubtitleRequests = new Map();

// Hàm làm sạch nội dung phụ đề
function cleanSubtitleContent(content) {
    if (!content || content.trim() === '') {
        logger.error('Empty content input for cleaning');
        return null;
    }

    try {
        // Loại bỏ các thẻ HTML/XML nhưng giữ nội dung bên trong
        let cleanedContent = content
            .replace(/<[^>]+>/g, '') // Loại bỏ thẻ HTML
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\u200B/g, '') // Loại bỏ zero-width space
            .replace(/\u200C/g, '') // Loại bỏ zero-width non-joiner
            .replace(/\u200D/g, '') // Loại bỏ zero-width joiner
            .replace(/\u200E/g, '') // Loại bỏ left-to-right mark
            .replace(/\u200F/g, ''); // Loại bỏ right-to-left mark

        // Loại bỏ các ký tự điều khiển nhưng giữ Unicode
        cleanedContent = cleanedContent.replace(/[\x00-\x1F\x7F-\x9F]/g, '');

        // Loại bỏ các định dạng đặc biệt
        cleanedContent = cleanedContent
            .replace(/align:start/g, '')
            .replace(/position:\d+%/g, '')
            .replace(/<c>/g, '')
            .replace(/<\/c>/g, '');

        // Giữ lại các dòng timestamp và nội dung phụ đề
        const lines = cleanedContent.split('\n');
        const validLines = lines.filter(line => {
            const trimmedLine = line.trim();
            if (!trimmedLine) return false;

            // Kiểm tra timestamp
            if (trimmedLine.match(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/)) {
                return true;
            }

            // Kiểm tra nội dung phụ đề có chứa ký tự hợp lệ không
            return /[\p{L}\p{N}\p{P}\p{Z}\p{S}]/u.test(trimmedLine);
        });

        cleanedContent = validLines.join('\n').trim();

        // Kiểm tra xem nội dung sau khi làm sạch có hợp lệ không
        if (!cleanedContent || !cleanedContent.includes('-->')) {
            logger.error('No valid subtitle content after cleaning');
            logger.debug('Original content:', content);
            return null;
        }

        // Kiểm tra xem có ít nhất một dòng nội dung phụ đề không
        const hasContent = validLines.some(line => 
            !line.match(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/) &&
            /[\p{L}\p{N}\p{P}\p{Z}\p{S}]/u.test(line)
        );

        if (!hasContent) {
            logger.error('No valid subtitle text content found');
            logger.debug('Cleaned content:', cleanedContent);
            return null;
        }

        return cleanedContent;
    } catch (error) {
        logger.error(`Error cleaning subtitle content: ${error.message}`);
        logger.debug('Original content:', content);
        return null;
    }
}

// Hàm kiểm tra ngôn ngữ phụ đề
function detectSubtitleLanguage(content) {
    if (!content) return null;
    
    // Danh sách các ký tự đặc trưng cho các ngôn ngữ
    const languagePatterns = {
        'vi': /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i,
        'zh': /[\u4e00-\u9fff]/,
        'ja': /[\u3040-\u309f\u30a0-\u30ff]/,
        'ko': /[\uac00-\ud7af\u1100-\u11ff]/,
        'th': /[\u0e00-\u0e7f]/,
        'ar': /[\u0600-\u06ff]/,
        'ru': /[\u0400-\u04ff]/,
        'en': /^[a-zA-Z\s.,!?'"-]+$/
    };

    for (const [lang, pattern] of Object.entries(languagePatterns)) {
        if (pattern.test(content)) {
            return lang;
        }
    }
    
    return null;
}

// Hàm tải phụ đề bằng yt-dlp với kiểm tra ngôn ngữ
async function downloadSubtitleWithYtDlp(url, language, outputPath) {
    const options = {
        skipDownload: true,
        subFormat: 'vtt',
        output: outputPath,
        noCheckCertificates: true,
        noWarnings: true,
        preferFreeFormats: true,
        addHeader: [
            'referer:youtube.com',
            'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        ],
        writeAutoSub: true,
        writeSub: true,
        subLang: language,
        extractAudio: false,
        noPlaylist: true,
        retries: 3,
        fragmentRetries: 3,
        fileAccessRetries: 3,
        retrySleeper: 1,
        socketTimeout: 30,
        sourceAddress: '0.0.0.0',
        concurrent: 4,
        bufferSize: 1024 * 1024,
        maxFilesize: '2G',
        maxDownloads: 1,
        // Thêm các tùy chọn mới để khắc phục lỗi nsig
        format: 'best',
        noPlaylist: true,
        noWarnings: true,
        noCheckCertificates: true,
        preferInsecure: true,
        addHeader: [
            'referer:youtube.com',
            'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        ]
    };

    try {
        // Thử tải phụ đề thủ công trước
        await ytDlp(url, { ...options, writeAutoSub: false });
        
        if (await fsPromises.access(outputPath).then(() => true).catch(() => false)) {
            const content = await fsPromises.readFile(outputPath, 'utf8');
            await fsPromises.unlink(outputPath).catch(() => {});
            
            if (content && content.trim() !== '') {
                return content;
            }
        }

        // Nếu không có phụ đề thủ công, thử tải phụ đề tự động
        await ytDlp(url, { ...options, writeSub: false });
        
        if (await fsPromises.access(outputPath).then(() => true).catch(() => false)) {
            const content = await fsPromises.readFile(outputPath, 'utf8');
            await fsPromises.unlink(outputPath).catch(() => {});
            
            if (content && content.trim() !== '') {
                return content;
            }
        }

        // Thử tải phụ đề tiếng Anh nếu không tìm thấy phụ đề cho ngôn ngữ yêu cầu
        if (language !== 'en') {
            const enOptions = { ...options, subLang: 'en' };
            const enOutputPath = outputPath.replace(`.${language}.`, '.en.');
            
            // Thử tải phụ đề thủ công tiếng Anh
            await ytDlp(url, { ...enOptions, writeAutoSub: false });
            
            if (await fsPromises.access(enOutputPath).then(() => true).catch(() => false)) {
                const content = await fsPromises.readFile(enOutputPath, 'utf8');
                await fsPromises.unlink(enOutputPath).catch(() => {});
                
                if (content && content.trim() !== '') {
                    logger.info(`Using English subtitles as fallback for ${language}`);
                    return content;
                }
            }

            // Thử tải phụ đề tự động tiếng Anh
            await ytDlp(url, { ...enOptions, writeSub: false });
            
            if (await fsPromises.access(enOutputPath).then(() => true).catch(() => false)) {
                const content = await fsPromises.readFile(enOutputPath, 'utf8');
                await fsPromises.unlink(enOutputPath).catch(() => {});
                
                if (content && content.trim() !== '') {
                    logger.info(`Using English auto-subtitles as fallback for ${language}`);
                    return content;
                }
            }
        }
        
        logger.warn(`Subtitle file not found at ${outputPath}`);
        return null;
    } catch (error) {
        logger.error(`yt-dlp download failed for language ${language}: ${error.message}`);
        return null;
    }
}

// Hàm tải phụ đề bằng @distube/ytdl-core với kiểm tra ngôn ngữ
async function downloadSubtitleWithYtdlCore(videoId, language) {
    try {
        logger.info(`Attempting to download subtitle with ytdl-core: ${videoId}, language: ${language}`);
        
        const video = await ytdl.getInfo(videoId);
        if (!video) {
            throw new Error('Không thể lấy thông tin video');
        }

        // Kiểm tra phụ đề có sẵn
        const captions = video.player_response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        if (!captions || captions.length === 0) {
            throw new Error('Video không có phụ đề');
        }

        // Tìm phụ đề phù hợp
        const targetCaption = captions.find(caption => {
            const lang = caption.languageCode;
            return lang === language || lang === language.replace('.auto', '');
        });

        if (!targetCaption) {
            throw new Error(`Không tìm thấy phụ đề cho ngôn ngữ ${language}`);
        }

        // Tải phụ đề
        const response = await fetch(targetCaption.baseUrl);
        if (!response.ok) {
            throw new Error(`Lỗi khi tải phụ đề: ${response.statusText}`);
        }

        let subtitleContent = await response.text();
        if (!subtitleContent || subtitleContent.trim() === '') {
            throw new Error('Nội dung phụ đề rỗng sau khi tải');
        }

        // Kiểm tra và chuyển đổi định dạng nếu cần
        if (subtitleContent.includes('<?xml')) {
            subtitleContent = convertXmlToVtt(subtitleContent);
            if (!subtitleContent) {
                throw new Error('Không thể chuyển đổi phụ đề XML sang VTT');
            }
        }

        // Làm sạch nội dung
        subtitleContent = cleanSubtitleContent(subtitleContent);
        if (!subtitleContent) {
            throw new Error('Không thể làm sạch nội dung phụ đề');
        }

        // Kiểm tra nội dung cuối cùng
        if (!subtitleContent.includes('-->')) {
            throw new Error('Nội dung phụ đề không hợp lệ sau khi xử lý');
        }

        logger.info(`Successfully downloaded subtitle with ytdl-core: ${videoId}, language: ${language}`);
        return subtitleContent;

    } catch (error) {
        logger.error(`Failed to download subtitle with ytdl-core: ${error.message}`, {
            videoId,
            language,
            error: error.stack
        });
        throw error;
    }
}

// Hàm tải phụ đề bằng node-youtube-subtitles
async function downloadSubtitleWithNodeSubtitles(videoId, language) {
    try {
        const { getSubtitles } = require('node-youtube-subtitles');
        
        // Thử tải phụ đề thủ công trước
        let subtitles = await getSubtitles({ 
            videoID: videoId, 
            lang: language 
        });

        // Nếu không có phụ đề thủ công, thử tải phụ đề tự động
        if (!subtitles || subtitles.length === 0) {
            subtitles = await getSubtitles({ 
                videoID: videoId, 
                lang: `${language}.auto` 
            });
        }

        // Nếu vẫn không có, thử tải phụ đề tiếng Anh làm fallback
        if (!subtitles || subtitles.length === 0) {
            subtitles = await getSubtitles({ 
                videoID: videoId, 
                lang: 'en' 
            });
        }

        if (subtitles && subtitles.length > 0) {
            const content = arrayToVtt(subtitles);
            if (!content || content.trim() === '') {
                logger.warn(`Empty subtitle content from node-youtube-subtitles for language ${language}`);
                return null;
            }

            // Kiểm tra và làm sạch nội dung
            const cleanedContent = cleanSubtitleContent(content);
            if (!cleanedContent) {
                logger.warn(`Failed to clean subtitle content from node-youtube-subtitles for language ${language}`);
                return null;
            }

            return content;
        }

        logger.warn(`No subtitles found with node-youtube-subtitles for language ${language}`);
        return null;
    } catch (error) {
        logger.error(`node-youtube-subtitles Error for language ${language}: ${error.message}`);
        return null;
    }
}

// Hàm tải phụ đề bằng YouTube API
async function downloadSubtitleWithYouTubeAPI(videoId, language) {
    try {
        // Thử tải phụ đề thủ công trước
        const manualUrl = `https://www.youtube.com/api/timedtext?lang=${language}&v=${videoId}`;
        const manualResponse = await fetchWithRetry(manualUrl, { 
            responseType: 'text',
            timeout: 10000,
            retries: 3,
            delay: 1000
        });

        if (manualResponse && manualResponse.data) {
            const content = manualResponse.data;
            if (content && content.trim() !== '') {
                return content;
            }
        }

        // Nếu không có phụ đề thủ công, thử tải phụ đề tự động
        const autoUrl = `https://www.youtube.com/api/timedtext?lang=${language}&tlang=${language}&v=${videoId}`;
        const autoResponse = await fetchWithRetry(autoUrl, { 
            responseType: 'text',
            timeout: 10000,
            retries: 3,
            delay: 1000
        });

        if (autoResponse && autoResponse.data) {
            const content = autoResponse.data;
            if (content && content.trim() !== '') {
                return content;
            }
        }

        // Nếu vẫn không có, thử tải phụ đề tiếng Anh làm fallback
        const enUrl = `https://www.youtube.com/api/timedtext?lang=en&v=${videoId}`;
        const enResponse = await fetchWithRetry(enUrl, { 
            responseType: 'text',
            timeout: 10000,
            retries: 3,
            delay: 1000
        });

        if (enResponse && enResponse.data) {
            const content = enResponse.data;
            if (content && content.trim() !== '') {
                logger.info(`Using English subtitles as fallback for ${language}`);
                return content;
            }
        }

        logger.warn(`No subtitles found with YouTube API for language ${language}`);
        return null;
    } catch (error) {
        logger.error(`YouTube API subtitle download failed for language ${language}: ${error.message}`);
        return null;
    }
}

// Hàm chuyển đổi định dạng phụ đề
function convertSubtitleFormat(content, format) {
    if (!content || content.trim() === '') {
        logger.error('Empty subtitle content for format conversion');
        return null;
    }

    try {
        let convertedContent = null;
        switch (format.toLowerCase()) {
            case 'srt':
                convertedContent = convertVttToSrt(content);
                break;
            case 'txt':
                convertedContent = extractTextFromVtt(content);
                break;
            case 'vtt':
                // Kiểm tra và thêm header WEBVTT nếu cần
                convertedContent = content.includes('WEBVTT') ? content : `WEBVTT\n\n${content}`;
                break;
            default:
                throw new Error(`Định dạng không được hỗ trợ: ${format}`);
        }

        if (!convertedContent || convertedContent.trim() === '') {
            logger.error(`Empty content after converting to ${format.toUpperCase()}`);
            logger.debug('Original content:', content);
            return null;
        }

        logger.info(`Successfully converted subtitle to ${format.toUpperCase()} format`);
        return convertedContent;
    } catch (error) {
        logger.error(`Error converting subtitle format: ${error.message}`);
        logger.debug('Original content:', content);
        return null;
    }
}

// Hàm chuyển đổi VTT sang SRT
function convertVttToSrt(vttText) {
    if (!vttText || vttText.trim() === '') {
        logger.error('Empty VTT content');
        return null;
    }

    try {
        // Thêm header WEBVTT nếu chưa có
        if (!vttText.includes('WEBVTT')) {
            vttText = `WEBVTT\n\n${vttText}`;
        }

        let srtText = '';
        const lines = vttText.split('\n');
        let i = 0;
        let subtitleCount = 0;
        let hasValidContent = false;

        // Debug info
        const debugInfo = {
            totalLines: lines.length,
            timestampLines: 0,
            contentLines: 0,
            emptyLines: 0
        };

        // Bỏ qua header WEBVTT và các dòng trống đầu tiên
        while (i < lines.length && (lines[i].startsWith('WEBVTT') || lines[i].trim() === '')) {
            i++;
        }

        while (i < lines.length) {
            const timeMatch = lines[i].match(/(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})/);
            if (timeMatch) {
                debugInfo.timestampLines++;
                const startTime = timeMatch[1].replace('.', ',');
                const endTime = timeMatch[2].replace('.', ',');
                i++;
                
                let subtitleText = '';
                let hasText = false;

                while (i < lines.length && lines[i].trim() !== '') {
                    debugInfo.contentLines++;
                    // Loại bỏ các thẻ HTML/XML và định dạng đặc biệt
                    let cleanLine = lines[i]
                        .replace(/<[^>]+>/g, '') // Loại bỏ thẻ HTML
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
                        .replace(/\u200B/g, '') // Loại bỏ zero-width space
                        .replace(/\u200C/g, '') // Loại bỏ zero-width non-joiner
                        .replace(/\u200D/g, '') // Loại bỏ zero-width joiner
                        .replace(/\u200E/g, '') // Loại bỏ left-to-right mark
                        .replace(/\u200F/g, '') // Loại bỏ right-to-left mark
                        .trim();

                    if (cleanLine) {
                        subtitleText += (subtitleText ? '\n' : '') + cleanLine;
                        hasText = true;
                    }
                    i++;
                }

                if (hasText) {
                    srtText += `${startTime} --> ${endTime}\n${subtitleText.trim()}\n\n`;
                    subtitleCount++;
                    hasValidContent = true;
                }
            } else {
                if (lines[i].trim() === '') {
                    debugInfo.emptyLines++;
                }
                i++;
            }
        }

        if (!hasValidContent) {
            logger.error('No valid subtitles found in VTT content', {
                debugInfo,
                vttContent: vttText
            });
            return null;
        }

        if (subtitleCount === 0) {
            logger.error('No valid subtitles after conversion to SRT', {
                debugInfo,
                vttContent: vttText
            });
            return null;
        }

        logger.info(`Converted ${subtitleCount} subtitles to SRT format`, { debugInfo });
        return srtText.trim();
    } catch (error) {
        logger.error(`VTT to SRT conversion failed: ${error.message}`, {
            error: error.stack,
            vttContent: vttText
        });
        return null;
    }
}

// Hàm xử lý tải phụ đề
async function handleDownloadSubtitle(req, res, downloadProgressMap) {
    const { url, platform, targetLanguage, formatPreference } = req.body;

    // Kiểm tra dữ liệu đầu vào
    if (!url || !platform) {
        logger.warn(`Missing required fields (url, platform) from IP: ${req.ip}`);
        throw new Error('Thiếu thông tin cần thiết (url, platform)');
    }

    // Áp dụng giới hạn tốc độ
    await subtitleRateLimiter.consume(`download_subtitle_${req.ip}`, 1);

    // Xử lý ngôn ngữ và định dạng
    const defaultLanguage = await getDefaultLanguage(req.ip);
    const selectedLanguage = targetLanguage || defaultLanguage;
    const selectedFormat = formatPreference ? formatPreference.toLowerCase() : 'srt';

    // Kiểm tra định dạng hợp lệ
    if (!['srt', 'vtt', 'txt'].includes(selectedFormat)) {
        throw new Error('Định dạng không được hỗ trợ. Chỉ hỗ trợ: srt, vtt, txt.');
    }

    logger.info(`Download subtitle request: ${platform}, URL: ${url}, Language: ${selectedLanguage} (default: ${defaultLanguage}), Format: ${selectedFormat}, IP: ${req.ip}`);

    // Tạo thư mục lưu trữ phụ đề
    const subtitlesDir = path.join(__dirname, 'subtitles');
    if (!await fs.access(subtitlesDir).then(() => true).catch(() => false)) {
        await fs.mkdir(subtitlesDir, { recursive: true });
    }

    // Dọn dẹp thư mục phụ đề
    await cleanFolder(subtitlesDir);

    // Tạo ID tải xuống và lưu vào tiến trình
    const downloadId = uuidv4();
    downloadProgressMap.set(downloadId, { progress: 0, error: null });

    // Kiểm tra yêu cầu trùng lặp
    const requestKey = `${url}:${selectedLanguage}:${selectedFormat}`;
    if (activeSubtitleRequests.has(requestKey)) {
        logger.warn(`Duplicate subtitle request detected for ${requestKey}, IP: ${req.ip}`);
        return res.status(429).json({ error: 'Yêu cầu tải phụ đề đang được xử lý. Vui lòng chờ!' });
    }
    activeSubtitleRequests.set(requestKey, downloadId);

    // Trả về ngay lập tức với downloadId để client theo dõi tiến trình
    res.status(200).json({ message: 'Đang tải phụ đề, vui lòng chờ...', downloadId });

    // Tải phụ đề bất đồng bộ
    (async () => {
        try {
            if (platform !== 'youtube') {
                throw new Error('Hiện tại chỉ hỗ trợ nền tảng YouTube.');
            }

            // Kiểm tra URL và trích xuất video ID
            const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?&]+)/)?.[1];
            if (!videoId) {
                throw new Error('URL YouTube không hợp lệ');
            }

            // Kiểm tra tính khả dụng của video
            const availability = await checkVideoAvailability(videoId);
            if (!availability.isAvailable) {
                throw new Error(availability.reason);
            }

            // Lấy danh sách ngôn ngữ phụ đề khả dụng
            const { manual: manualLanguages, auto: autoLanguages } = await getAvailableSubtitleLanguages(url);
            const allLanguages = [...new Set([...manualLanguages, ...autoLanguages])];
            
            if (allLanguages.length === 0) {
                throw new Error('Video không có phụ đề nào khả dụng.');
            }

            // Kiểm tra xem ngôn ngữ yêu cầu có khả dụng không
            if (!allLanguages.includes(selectedLanguage)) {
                const availableLangs = allLanguages.join(', ');
                throw new Error(`Không tìm thấy phụ đề cho ngôn ngữ ${selectedLanguage}. Các ngôn ngữ khả dụng: ${availableLangs}`);
            }

            // Xác định ngôn ngữ cuối cùng
            let finalLanguage = selectedLanguage;
            if (manualLanguages.includes(selectedLanguage)) {
                finalLanguage = selectedLanguage;
            } else if (autoLanguages.includes(selectedLanguage)) {
                finalLanguage = `${selectedLanguage}.auto`;
            } else {
                // Thử tìm ngôn ngữ thay thế
                if (manualLanguages.includes(defaultLanguage)) {
                    finalLanguage = defaultLanguage;
                } else if (autoLanguages.includes(defaultLanguage)) {
                    finalLanguage = `${defaultLanguage}.auto`;
                } else {
                    finalLanguage = manualLanguages[0] || `${autoLanguages[0]}.auto`;
                }
                logger.info(`Ngôn ngữ ${selectedLanguage} không khả dụng, sử dụng ${finalLanguage} thay thế`);
            }

            // Cập nhật tiến trình
            downloadProgressMap.set(downloadId, { progress: 30, error: null });

            // Thử tải phụ đề bằng nhiều phương pháp
            let subtitleContent = null;
            let downloadMethod = '';
            let downloadError = null;

            // Phương pháp 1: Sử dụng @distube/ytdl-core
            try {
                subtitleContent = await downloadSubtitleWithYtdlCore(videoId, finalLanguage);
                if (subtitleContent) {
                    downloadMethod = 'ytdl-core';
                    logger.info('Successfully downloaded subtitles using ytdl-core');
                }
            } catch (error) {
                downloadError = error;
                logger.error(`ytdl-core download failed: ${error.message}`);
            }

            // Phương pháp 2: Thử với yt-dlp nếu phương pháp 1 thất bại
            if (!subtitleContent) {
                try {
                    const outputPath = path.join(tempDir, `${videoTitle}.${finalLanguage}.vtt`);
                    subtitleContent = await downloadSubtitleWithYtDlp(url, finalLanguage, outputPath);
                    if (subtitleContent) {
                        downloadMethod = 'yt-dlp';
                        logger.info('Successfully downloaded subtitles using yt-dlp');
                    }
                } catch (error) {
                    downloadError = error;
                    logger.error(`yt-dlp download failed: ${error.message}`);
                }
            }

            // Phương pháp 3: Thử với node-youtube-subtitles
            if (!subtitleContent) {
                try {
                    subtitleContent = await downloadSubtitleWithNodeSubtitles(videoId, finalLanguage);
                    if (subtitleContent) {
                        downloadMethod = 'node-youtube-subtitles';
                        logger.info('Successfully downloaded subtitles using node-youtube-subtitles');
                    }
                } catch (error) {
                    downloadError = error;
                    logger.error(`node-youtube-subtitles download failed: ${error.message}`);
                }
            }

            // Phương pháp 4: Thử với YouTube API
            if (!subtitleContent) {
                try {
                    subtitleContent = await downloadSubtitleWithYouTubeAPI(videoId, finalLanguage);
                    if (subtitleContent) {
                        downloadMethod = 'youtube-api';
                        logger.info('Successfully downloaded subtitles using YouTube API');
                    }
                } catch (error) {
                    downloadError = error;
                    logger.error(`YouTube API download failed: ${error.message}`);
                }
            }

            // Kiểm tra nội dung phụ đề
            if (!subtitleContent || subtitleContent.trim() === '') {
                const errorMessage = downloadError ? 
                    `Không thể tải phụ đề cho ngôn ngữ ${selectedLanguage}. Lỗi: ${downloadError.message}` :
                    `Không thể tải phụ đề cho ngôn ngữ ${selectedLanguage}. Vui lòng thử ngôn ngữ khác.`;
                throw new Error(errorMessage);
            }

            // Cập nhật tiến trình
            downloadProgressMap.set(downloadId, { progress: 70, error: null });

            // Chuyển đổi định dạng
            const convertedContent = convertSubtitleFormat(subtitleContent, selectedFormat);
            if (!convertedContent) {
                throw new Error(`Không thể chuyển đổi phụ đề sang định dạng ${selectedFormat}. Vui lòng thử định dạng khác.`);
            }

            // Tạo tên file và lưu phụ đề
            const fileName = `${sanitizeFileName(videoTitle)}_${finalLanguage}.${selectedFormat}`;
            const filePath = path.join(subtitlesDir, fileName);
            
            try {
                await fs.writeFile(filePath, convertedContent, 'utf8');
                logger.info(`Successfully wrote subtitle file: ${filePath}`);

                // Kiểm tra file sau khi ghi
                const stats = await fs.stat(filePath);
                if (stats.size === 0) {
                    throw new Error('File phụ đề rỗng sau khi tạo.');
                }

                // Cập nhật tiến trình hoàn thành
                downloadProgressMap.set(downloadId, { 
                    progress: 100, 
                    downloadUrl: `/subtitles/${encodeURIComponent(fileName)}`, 
                    selectedLanguage: finalLanguage,
                    defaultLanguage: defaultLanguage,
                    availableLanguages: {
                        manual: manualLanguages,
                        auto: autoLanguages
                    },
                    error: null 
                });
            } catch (writeError) {
                logger.error(`Error writing subtitle file: ${writeError.message}`);
                throw new Error('Không thể lưu file phụ đề. Vui lòng thử lại!');
            }

        } catch (error) {
            logger.error(`Subtitle Download Error: ${error.message}`);
            let errorMessage;
            if (error.code === 'RATE_LIMITER_POINTS_EXCEEDED') {
                errorMessage = 'Quá nhiều yêu cầu. Vui lòng thử lại sau vài giây!';
            } else if (error.response) {
                errorMessage = error.response.data?.error?.message || error.message || 'Lỗi từ API tải phụ đề';
            } else if (error.code === 'ECONNABORTED') {
                errorMessage = 'Yêu cầu tải phụ đề hết thời gian. Vui lòng kiểm tra kết nối và thử lại!';
            } else {
                errorMessage = error.message || 'Lỗi server khi tải phụ đề. Vui lòng thử lại sau!';
            }
            downloadProgressMap.set(downloadId, { progress: 0, error: errorMessage });
        } finally {
            activeSubtitleRequests.delete(requestKey);
        }
    })();
}

// Hàm tải tất cả phụ đề
async function downloadAllSubtitles(url, downloadProgressMap) {
    const downloadId = uuidv4();
    downloadProgressMap.set(downloadId, { progress: 0, error: null });

    try {
        const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?&]+)/)?.[1];
        if (!videoId) {
            throw new Error('URL YouTube không hợp lệ');
        }

        // Kiểm tra tính khả dụng của video
        const availability = await checkVideoAvailability(videoId);
        if (!availability.isAvailable) {
            throw new Error(availability.reason);
        }

        // Lấy danh sách ngôn ngữ phụ đề khả dụng
        const { manual: manualLanguages, auto: autoLanguages } = await getAvailableSubtitleLanguages(url);
        const allLanguages = [...new Set([...manualLanguages, ...autoLanguages])];
        
        if (allLanguages.length === 0) {
            throw new Error('Video không có phụ đề nào khả dụng.');
        }

        // Tạo thư mục tạm và thư mục phụ đề
        const tempDir = path.join(__dirname, 'temp');
        const subtitlesDir = path.join(__dirname, 'subtitles');
        await fs.mkdir(tempDir, { recursive: true });
        await fs.mkdir(subtitlesDir, { recursive: true });
        await cleanFolder(subtitlesDir);

        // Lấy tiêu đề video
        const videoTitle = await getVideoTitle(videoId) || `Video_YouTube_${videoId}`;
        downloadProgressMap.set(downloadId, { progress: 20, error: null });

        const subtitleFiles = [];
        const formats = ['srt', 'vtt', 'txt'];
        let successCount = 0;

        // Tải phụ đề cho mỗi ngôn ngữ
        for (const lang of allLanguages) {
            try {
                let subtitleContent = null;
                let selectedLang = lang;

                // Phương pháp 1: Sử dụng @distube/ytdl-core
                subtitleContent = await downloadSubtitleWithYtdlCore(videoId, lang);

                // Phương pháp 2: Thử với yt-dlp nếu phương pháp 1 thất bại
                if (!subtitleContent) {
                    const outputPath = path.join(tempDir, `${videoTitle}.${lang}.vtt`);
                    subtitleContent = await downloadSubtitleWithYtDlp(url, lang, outputPath);
                }

                // Phương pháp 3: Thử với node-youtube-subtitles
                if (!subtitleContent) {
                    subtitleContent = await downloadSubtitleWithNodeSubtitles(videoId, lang);
                }

                // Phương pháp 4: Thử với YouTube API
                if (!subtitleContent) {
                    subtitleContent = await downloadSubtitleWithYouTubeAPI(videoId, lang);
                }

                if (subtitleContent && subtitleContent.trim() !== '') {
                    // Chuyển đổi sang các định dạng khác nhau
                    for (const format of formats) {
                        let content = subtitleContent;
                        if (format === 'txt') {
                            content = extractTextFromVtt(content);
                        } else if (format === 'srt') {
                            content = convertVttToSrt(content);
                        }

                        if (content && content.trim() !== '') {
                            const fileName = `${sanitizeFileName(videoTitle)}_${selectedLang}.${format}`;
                            const filePath = path.join(subtitlesDir, fileName);
                            await fs.writeFile(filePath, content, 'utf8');
                            subtitleFiles.push({
                                language: selectedLang,
                                format,
                                downloadUrl: `/subtitles/${encodeURIComponent(fileName)}`
                            });
                            successCount++;
                        }
                    }
                }
            } catch (langError) {
                logger.error(`Error downloading subtitles for ${lang}: ${langError.message}`);
            }
        }

        // Cập nhật tiến trình
        const progress = Math.min(20 + Math.floor((successCount / (allLanguages.length * formats.length)) * 80), 100);
        downloadProgressMap.set(downloadId, {
            progress,
            subtitles: subtitleFiles,
            error: null
        });

        // Xóa thư mục tạm
        try {
            await fs.rm(tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
            logger.error(`Error cleaning up temp directory: ${cleanupError.message}`);
        }

        return subtitleFiles;
    } catch (error) {
        logger.error(`Download All Subtitles Error: ${error.message}`);
        downloadProgressMap.set(downloadId, { progress: 0, error: error.message });
        throw error;
    }
}

async function downloadSubtitleWithRetry(url, language, isAuto = false, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            // Phương pháp 1: Sử dụng @distube/ytdl-core
            const info = await ytdl.getInfo(url, { 
                timeout: 30000,
                requestOptions: {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    }
                }
            });
            const captions = info.player_response.captions;
            if (!captions || !captions.playerCaptionsTracklistRenderer) {
                throw new Error('Video không có phụ đề nào');
            }

            const captionTracks = captions.playerCaptionsTracklistRenderer.captionTracks || [];
            const translationLanguages = captions.playerCaptionsTracklistRenderer.translationLanguages || [];
            
            let subtitleContent = null;
            if (!isAuto) {
                const caption = captionTracks.find(track => track.languageCode === language);
                if (caption) {
                    const response = await fetchWithRetry(caption.baseUrl, { 
                        responseType: 'text',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                        }
                    }, 3, 2000);
                    subtitleContent = response.data;
                }
            } else {
                const autoLang = translationLanguages.find(tLang => tLang.languageCode === language);
                if (autoLang && captionTracks[0]) {
                    const autoCaptionUrl = `${captionTracks[0]?.baseUrl}&tlang=${language}`;
                    const response = await fetchWithRetry(autoCaptionUrl, { 
                        responseType: 'text',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                        }
                    }, 3, 2000);
                    subtitleContent = response.data;
                }
            }

            if (subtitleContent && subtitleContent.trim()) {
                return subtitleContent;
            }

            // Phương pháp 2: Sử dụng yt-dlp
            const tempDir = path.join(__dirname, 'temp');
            if (!await fsPromises.access(tempDir).then(() => true).catch(() => false)) {
                await fsPromises.mkdir(tempDir, { recursive: true });
            }

            const outputPath = path.join(tempDir, `subtitle_${language}.vtt`);
            await ytDlp(url, {
                skipDownload: true,
                writeSub: !isAuto,
                writeAutoSub: isAuto,
                subLang: language,
                subFormat: 'vtt',
                output: outputPath,
                timeout: 30000
            });

            if (await fsPromises.access(outputPath).then(() => true).catch(() => false)) {
                subtitleContent = await fsPromises.readFile(outputPath, 'utf8');
                await fsPromises.unlink(outputPath);
                if (subtitleContent && subtitleContent.trim()) {
                    return subtitleContent;
                }
            }

            // Phương pháp 3: Sử dụng youtube-caption-extractor
            const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.match(/youtu\.be\/([^?&]+)/)?.[1];
            if (videoId) {
                let subtitles = await getYTSubtitles({ 
                    videoId, 
                    lang: language,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                    }
                });
                if (!subtitles || subtitles.length === 0) {
                    subtitles = await getYTSubtitles({ 
                        videoId, 
                        lang: language, 
                        tlang: language,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                        }
                    });
                }
                if (subtitles && subtitles.length > 0) {
                    subtitleContent = arrayToVtt(subtitles);
                    if (subtitleContent && subtitleContent.trim()) {
                        return subtitleContent;
                    }
                }
            }

            throw new Error('Không thể tải phụ đề từ bất kỳ phương pháp nào');
        } catch (error) {
            logger.error(`Attempt ${attempt + 1}/${retries} failed: ${error.message}`);
            if (attempt === retries - 1) {
                throw error;
            }
            // Tăng thời gian chờ giữa các lần thử
            await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt), 10000)));
        }
    }
}

// Hàm chuyển đổi phụ đề sang VTT (chỉ giữ thời gian và văn bản)
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

// Hàm chuyển đổi phụ đề sang SRT (chỉ giữ thời gian và văn bản)
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

// Hàm chuyển đổi phụ đề sang XML (chỉ giữ thời gian và văn bản)
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

// Hàm chuyển đổi phụ đề sang TXT (chỉ văn bản)
function arrayToTxt(subtitles) {
    if (!subtitles || subtitles.length === 0) return null;
    const text = subtitles
        .filter(sub => (sub.subtitle || sub.text) && (sub.subtitle || sub.text).trim())
        .map(sub => truncateSubtitleText(sub.subtitle || sub.text))
        .join('\n\n');
    return text.trim() === '' ? null : text.trim();
}

// Hàm cắt ngắn văn bản phụ đề
function truncateSubtitleText(text, maxLength = 40) {
    if (!text) return '';
    
    // Loại bỏ các thẻ HTML/XML và định dạng đặc biệt
    let cleanText = text
        .replace(/<[^>]+>/g, '') // Loại bỏ thẻ HTML
        .replace(/align:start/g, '')
        .replace(/position:\d+%/g, '')
        .replace(/<c>/g, '')
        .replace(/<\/c>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\u200B/g, '') // Loại bỏ zero-width space
        .replace(/\u200C/g, '') // Loại bỏ zero-width non-joiner
        .replace(/\u200D/g, '') // Loại bỏ zero-width joiner
        .replace(/\u200E/g, '') // Loại bỏ left-to-right mark
        .replace(/\u200F/g, '') // Loại bỏ right-to-left mark
        .trim();

    // Nếu văn bản dài hơn maxLength, cắt ngắn và thêm dấu ...
    if (cleanText.length > maxLength) {
        cleanText = cleanText.substring(0, maxLength) + '...';
    }

    return cleanText;
}

module.exports = {
    handleDownloadSubtitle,
    downloadAllSubtitles
};