import { Request, ResponseToolkit } from "@hapi/hapi";
import axios from "axios";
import { assertHttpUrl, getProxiedUrl } from "../utils/url.utils";
import { IncomingMessage } from "http";
import { serverState } from "../services/state.service";
import https from "https";

// Re-use agent to keep connections alive for sequential segment fetches
// const agent = new https.Agent({
//     keepAlive: true,
//     maxSockets: 100,
//     maxFreeSockets: 10,
//     timeout: 60000
// });

// --- HELPER: Security Check ---
const validateRequest = (request: Request) => {
    // 1. Check Global Switch
    if (!serverState.isProxyEnabled) {
        return { valid: false, error: "Proxy is disabled by Admin", code: 403 };
    }

    // 2. Referer Guard (Anti-Hotlink)
    // We expect requests to come from our own frontend (UI).
    // If a request has NO referer, it might be a direct script or bot.
    // However, some privacy browsers block Referer, so we permit "undefined" for now,
    // but strictly block if the referer exists and doesn't match our host.
    const reqReferer = request.headers.referer;
    const host = request.info.host; // e.g., "localhost:8000" or "mysite.com"

    // If Referer exists, it MUST contain our host.
    if (reqReferer && !reqReferer.includes(host)) {
        return { valid: false, error: "Unauthorized Referer", code: 403 };
    }

    return { valid: true };
};

export const proxyStreamHandler = async (request: Request, h: ResponseToolkit) => {
    // [SECURITY STEP] Validate before processing
    const check = validateRequest(request);
    if (!check.valid) return h.response({ error: check.error }).code(check.code!);

    const { url, ref, headers: headersParam } = request.query;
    if (!url) return h.response({ error: 'No URL' }).code(400);

    try {
        const decodedUrl = Buffer.from(url, 'base64').toString('utf-8');
        const referer = ref ? Buffer.from(ref, 'base64').toString('utf-8') : undefined;

        let customHeaders: Record<string, string> = {};
        if (headersParam) {
            try {
                const jsonHeaders = Buffer.from(headersParam, 'base64').toString('utf-8');
                customHeaders = JSON.parse(jsonHeaders);
            } catch (e) {
                console.warn("Failed to parse custom headers param");
            }
        }

        const requestHeaders: Record<string, string | undefined> = {
            'Referer': referer,
            'User-Agent': request.headers['user-agent'],
            'Accept': request.headers['accept'],
            'Accept-Encoding': request.headers['accept-encoding'],
            ...customHeaders
        };
        if (request.headers.range) requestHeaders['Range'] = request.headers.range;

        const response = await axios.get(decodedUrl, {
            responseType: 'stream',
            headers: requestHeaders,
            validateStatus: () => true,
            decompress: false,
            // httpsAgent: agent, // Use keep-alive agent
            timeout: 30000 // 30s timeout per segment
        });
        const stream = response.data as IncomingMessage;
        const hapiResponse = h.response(stream).code(response.status);
        const headersToCopy = [
            'content-type', 'content-length', 'accept-ranges',
            'content-range', 'date', 'last-modified', 'etag',
        ];
        for (const [key, value] of Object.entries(response.headers)) {
            if (value && headersToCopy.includes(key.toLowerCase())) {
                hapiResponse.header(key, value.toString());
            }
        }
        return hapiResponse;
    } catch (error: any) {
        console.error('[/proxy/stream] error:', error.message || error);
        return h.response({ error: 'Upstream error' }).code(500);
    }
};

export const proxyPlaylistHandler = async (request: Request, h: ResponseToolkit) => {
    // [SECURITY STEP] Validate before processing
    const check = validateRequest(request);
    if (!check.valid) return h.response({ error: check.error }).code(check.code!);

    try {
        const { url, ref } = request.query;
        if (!url) return h.response({ error: "No URL" }).code(400);

        const decodedUrl = Buffer.from(url, "base64").toString("utf-8");
        const referer = ref ? Buffer.from(ref, "base64").toString("utf-8") : undefined;

        if (decodedUrl.match(/\.(ts|mp4|mkv|webm)($|\?)/i)) {
            const streamUrl = `/api/proxy/stream?url=${url}` + (ref ? `&ref=${ref}` : "");
            return h.redirect(streamUrl);
        }

        const playlistUrl = assertHttpUrl(decodedUrl).href;
        const headers: Record<string, string> = {};
        if (referer) headers["Referer"] = referer;

        const resp = await axios.get<string>(playlistUrl, {
            responseType: "text",
            headers,
            validateStatus: () => true,
            // httpsAgent: agent,
            timeout: 10000 // 10s for playlist
        });
        if (resp.status < 200 || resp.status >= 300) return h.response({ error: "Fetch failed" }).code(resp.status);

        const body = resp.data || "";
        if (!body.startsWith("#EXTM3U")) {
            const streamUrl = `/api/proxy/stream?url=${url}` + (ref ? `&ref=${ref}` : "");
            return h.redirect(streamUrl);
        }

        const urlRegex = /(URI=["']([^"']+)["'])|((^\s*[^#\n\r].*)$)/gm;
        const rewritten = body.replace(
            urlRegex,
            (match, uriAttribute, uriValue, segmentUrl) => {
                const urlToRewrite = uriValue || segmentUrl;
                if (!urlToRewrite) return match;

                const absolute = new URL(urlToRewrite, playlistUrl).href;
                const b64url = Buffer.from(absolute).toString("base64");
                const b64ref = referer ? Buffer.from(referer).toString("base64") : undefined;

                let proxiedUrl: string;
                const isPlaylist = urlToRewrite.match(/\.m3u8($|\?)/i);
                const isSegment = urlToRewrite.match(/\.ts($|\?)/i);

                if (isPlaylist) {
                    proxiedUrl = `/api/proxy?url=${b64url}` + (b64ref ? `&ref=${b64ref}` : "");
                } else if (isSegment) {
                    proxiedUrl = getProxiedUrl(absolute, referer);
                } else {
                    proxiedUrl = getProxiedUrl(absolute, referer);
                }

                if (uriValue) return `URI="${proxiedUrl}"`;
                return proxiedUrl;
            }
        );

        return h.response(rewritten).type("application/vnd.apple.mpegurl").header("Cache-Control", "no-cache");
    } catch (err: any) {
        console.error("[/proxy] error:", err?.message || err);
        return h.response({ error: "Proxy failed" }).code(500);
    }
};