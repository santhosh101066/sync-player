import { Request, ResponseToolkit } from "@hapi/hapi";
import { getYtDlpInfo } from "../utils/yt-dlp";
import { getCookiesHeader } from "../utils/cookies";
import axios from "axios";

// --- RESOLVE STREAM HANDLER ---
// Used to just get metadata/url without streaming
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
export const resolveHandler = async (request: Request, h: ResponseToolkit) => {
    const url = request.query.url as string;
    const id = request.query.id as string;
    const videoUrl = url || (id ? `https://www.youtube.com/watch?v=${id}` : null);

    if (!videoUrl) return h.response({ error: "No URL or ID provided" }).code(400);

    try {
        const info = await getYtDlpInfo(videoUrl) as any;

        // Find best format (Video + Audio preferred for direct play)
        // yt-dlp separates them often for high quality, but for simple resolve we want a combo file if possible
        let formats = info.formats.filter((f: any) => f.vcodec !== 'none');
        formats.sort((a: any, b: any) => (b.height || 0) - (a.height || 0));
        let format = formats[0];
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
            duration: info.duration,
            quality: format.height
        }).code(200);

    } catch (error: any) {
        console.error("[YouTube] Resolve error:", error.message);
        return h.response({ error: "Resolution failed" }).code(500);
    }
};

// --- STREAM HANDLER ---
// Proxies the video stream through our server
// --- STREAM HANDLER ---
// Proxies the video stream through our server
// Uses cached info to resolve the URL and proxies it with correct headers
export const streamHandler = async (request: Request, h: ResponseToolkit) => {
    const id = request.query.id as string;
    const itag = request.query.itag as string;
    // const start = request.query.start as string; 

    if (!id || !itag) return h.response({ error: "Missing params" }).code(400);

    try {
        // 1. Get Info (Should hit cache if recent)
        const info = await getYtDlpInfo(`https://www.youtube.com/watch?v=${id}`) as any;

        // 2. Find Format
        const format = info.formats.find((f: any) => f.format_id === itag);
        if (!format || !format.url) {
            console.error(`[Stream] Format ${itag} not found for video ${id}`);
            return h.response({ error: "Format not found" }).code(404);
        }

        // 3. Prepare Proxy Headers
        const cookies = getCookiesHeader('youtube.com');
        const proxyHeaders: Record<string, string | undefined> = {
            'User-Agent': UA,
            'Range': request.headers.range, // Forward client range
            'Accept': request.headers.accept || '*/*',
            'Accept-Encoding': 'identity', // Prevent double compression issues
            'Connection': 'keep-alive',
            'Referer': 'https://www.youtube.com/',
            'Origin': 'https://www.youtube.com'
        };

        if (cookies) {
            proxyHeaders['Cookie'] = cookies.replace(/[\r\n]/g, '');
        }

        // Add extra headers from yt-dlp if available
        const ytHeaders = format.http_headers || info.http_headers;
        if (ytHeaders) {
            Object.assign(proxyHeaders, ytHeaders);
        }

        // Debug Log
        console.log(`[Stream] Proxying ${itag} for ${id}`);
        // console.log(`[Stream] Upstream URL: ${format.url}`);
        // console.log(`[Stream] Upstream Headers:`, JSON.stringify(proxyHeaders));

        // 4. Proxy Request
        const response = await axios({
            method: 'GET',
            url: format.url,
            headers: proxyHeaders,
            responseType: 'stream',
            validateStatus: () => true, // Handle 4xx manually
            decompress: false
        });

        if (response.status >= 400) {
            console.error(`[Stream] Upstream error ${response.status} for ${itag}: ${response.statusText}`);
            return h.response({ error: "Upstream error" }).code(502);
        }

        const res = h.response(response.data);

        // Forward essential headers
        if (response.headers['content-range']) res.header('Content-Range', response.headers['content-range']);
        if (response.headers['content-length']) res.header('Content-Length', response.headers['content-length']);
        if (response.headers['content-type']) res.header('Content-Type', response.headers['content-type']);
        if (response.headers['accept-ranges']) res.header('Accept-Ranges', response.headers['accept-ranges']);

        return res.code(response.status);

    } catch (error: any) {
        console.error(`[Stream] Proxy failed: ${error.message}`);
        return h.response({ error: "Streaming failed" }).code(500);
    }
};

// --- SEARCH HANDLER ---
// We can use yts or yt-dlp search. Keeping yts for now if it works, or switch if broken.
// ytdl-core removal might break yts if they share deps? yts is standalone usually.
import yts from "yt-search";

export const searchHandler = async (request: Request, h: ResponseToolkit) => {
    const q = request.query.q as string;
    const page = parseInt(request.query.page as string) || 1;
    if (!q) return h.response({ error: "No query provided" }).code(400);

    try {
        // yts doesn't support pagination directly, so we fetch more results
        // and slice based on page number
        const result = await yts(q);
        const allVideos = result.videos;

        const itemsPerPage = 20;
        const startIndex = (page - 1) * itemsPerPage;
        const endIndex = startIndex + itemsPerPage;

        const videos = allVideos.slice(startIndex, endIndex).map((v) => ({
            id: v.videoId,
            title: v.title,
            thumbnail: v.thumbnail,
            author: v.author.name,
            duration: v.timestamp,
            views: v.views,
        }));

        return h.response({
            videos,
            hasMore: endIndex < allVideos.length,
            totalResults: allVideos.length
        }).code(200);
    } catch (error: any) {
        console.error("[YouTube] Search error:", error.message);
        return h.response({ error: "Search failed" }).code(500);
    }
}
