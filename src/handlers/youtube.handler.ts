import { Request, ResponseToolkit } from "@hapi/hapi";
import { getYtDlpInfo } from "../utils/yt-dlp";
import { getCookiesHeader } from "../utils/cookies";
import axios from "axios";

// --- RESOLVE STREAM HANDLER ---
// Used to just get metadata/url without streaming
export const resolveHandler = async (request: Request, h: ResponseToolkit) => {
    const url = request.query.url as string;
    const id = request.query.id as string;
    const videoUrl = url || (id ? `https://www.youtube.com/watch?v=${id}` : null);

    if (!videoUrl) return h.response({ error: "No URL or ID provided" }).code(400);

    try {
        const info = await getYtDlpInfo(videoUrl) as any;

        // Find best format (Video + Audio preferred for direct play)
        // yt-dlp separates them often for high quality, but for simple resolve we want a combo file if possible
        let format = info.formats.find((f: any) => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4');

        // Fallback to best video + audio match manually? 
        // For now just return the best combo or first available
        if (!format) {
            // Fallback: any video format (might be silent)
            format = info.formats.find((f: any) => f.vcodec !== 'none');
        }

        if (!format || !format.url) {
            return h.response({ error: "No suitable stream found" }).code(404);
        }

        return h.response({
            url: format.url,
            title: info.title,
            author: info.uploader,
            duration: info.duration
        }).code(200);

    } catch (error: any) {
        console.error("[YouTube] Resolve error:", error.message);
        return h.response({ error: "Resolution failed" }).code(500);
    }
};

// --- STREAM HANDLER ---
// Proxies the video stream through our server
export const streamHandler = async (request: Request, h: ResponseToolkit) => {
    const id = request.query.id as string;
    if (!id) return h.response({ error: "No ID provided" }).code(400);

    const videoUrl = `https://www.youtube.com/watch?v=${id}`;

    try {
        const info = await getYtDlpInfo(videoUrl) as any;
        const itag = request.query.itag as string;
        let format: any;

        if (itag) {
            // Precise selection for DASH/HLS
            format = info.formats.find((f: any) => f.format_id === itag);
            if (!format) {
                return h.response({ error: `Format ${itag} not found` }).code(404);
            }
        } else {
            // Auto-selection (Legacy/Default)
            // Try to find mp4 with audio+video
            const formats = info.formats.filter((f: any) => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4');
            // Sort by height desc
            formats.sort((a: any, b: any) => (b.height || 0) - (a.height || 0));
            format = formats[0];

            // Fallback
            if (!format) {
                format = info.formats.filter((f: any) => f.ext === 'mp4')[0];
            }
        }

        if (!format || !format.url) {
            return h.response({ error: "No suitable stream found" }).code(404);
        }

        // Log selected format
        if (!itag) console.log(`[YouTube] Selected format: ${format.format} (${format.ext})`);

        // Proxy the stream using Axios
        // The URL is signed BUT we need to pass headers to mimic a browser to avoid 403/Bot check
        try {
            const cookieHeader = getCookiesHeader();
            const headers: any = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Connection': 'keep-alive',
                'Referer': 'https://www.youtube.com/',
                'Origin': 'https://www.youtube.com'
            };

            if (cookieHeader) {
                headers['Cookie'] = cookieHeader;
            }

            // Forward Range header if present
            if (request.headers.range) {
                headers['Range'] = request.headers.range;
            }

            const response = await axios({
                method: 'GET',
                url: format.url,
                headers: headers,
                responseType: 'stream',
                validateStatus: (status) => status >= 200 && status < 400, // Accept 206
                maxContentLength: 524288000, // 500MB
                maxBodyLength: 524288000,    // 500MB
                timeout: 0,                   // No timeout for streams
                maxRedirects: 5,
                decompress: false             // Don't decompress, pipe as-is
            });

            const res = h.response(response.data)
                .type(format.vcodec !== 'none' ? `video/${format.ext}` : `audio/${format.ext}`)
                .header('Accept-Ranges', 'bytes');

            if (response.headers['content-length']) {
                res.header('Content-Length', response.headers['content-length']);
            }
            if (response.headers['content-range']) {
                res.header('Content-Range', response.headers['content-range']);
                res.code(206);
            }
            if (response.headers['content-disposition']) {
                res.header('Content-Disposition', response.headers['content-disposition']);
            }

            return res;

        } catch (error: any) {
            if (error.response) {
                console.error(`[Stream Proxy] Error ${error.response.status} from YouTube`);
            } else {
                console.error("[Stream Proxy] Request Error:", error.message);
            }
            throw new Error(`Stream error: ${error.message}`);
        }

    } catch (error: any) {
        console.error("[YouTube] Stream error:", error.message);
        return h.response({ error: "Streaming failed" }).code(500);
    }
};

// --- SEARCH HANDLER ---
// We can use yts or yt-dlp search. Keeping yts for now if it works, or switch if broken.
// ytdl-core removal might break yts if they share deps? yts is standalone usually.
import yts from "yt-search";

export const searchHandler = async (request: Request, h: ResponseToolkit) => {
    const q = request.query.q as string;
    if (!q) return h.response({ error: "No query provided" }).code(400);

    try {
        const result = await yts(q);
        const videos = result.videos.slice(0, 20).map((v) => ({
            id: v.videoId,
            title: v.title,
            thumbnail: v.thumbnail,
            author: v.author.name,
            duration: v.timestamp,
            views: v.views,
        }));

        return h.response({ videos }).code(200);
    } catch (error: any) {
        console.error("[YouTube] Search error:", error.message);
        return h.response({ error: "Search failed" }).code(500);
    }
}
