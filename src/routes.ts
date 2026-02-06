import { ServerRoute } from "@hapi/hapi";
import path from "path";
import { libraryHandler } from "./handlers/library.handler";
import { proxyPlaylistHandler, proxyStreamHandler } from "./handlers/proxy.handler";
import { uploadHandler } from "./handlers/upload.handler";
import { resolveHandler, searchHandler, streamHandler } from "./handlers/youtube.handler";
import { dashManifestHandler } from "./handlers/dash.handler";
import {
    cookieStatusHandler,
    cookieUploadHandler,
    cookieValidateHandler,
    clearCacheHandler,
    validateAdminToken
} from "./handlers/admin.handler";
import { checkAdminEmailHandler } from "./handlers/auth.handler";

export const routes: ServerRoute[] = [
    // A. Library API (Scans /downloads folder)
    {
        method: "GET",
        path: "/api/library",
        handler: libraryHandler,
    },
    // B. Static File Serving for downloaded videos
    {
        method: "GET",
        path: "/downloads/{param*}",
        handler: {
            directory: {
                path: path.join(process.cwd(), 'downloads'),
                redirectToSlash: true,
                index: false,
            },
        },
    },
    // C. Stream Proxy (Handles chunks/segments)
    {
        method: 'GET',
        path: '/api/proxy/stream',
        handler: proxyStreamHandler
    },
    // D. M3U8 Playlist Proxy (Rewrites internal URLs)
    {
        method: "GET",
        path: "/api/proxy",
        handler: proxyPlaylistHandler
    },
    // D2. YouTube API
    {
        method: "GET",
        path: "/api/youtube/search",
        handler: searchHandler
    },
    {
        method: "GET",
        path: "/api/youtube/bind", // Keeping resolve for metadata if needed, but streaming is primary
        handler: resolveHandler
    },
    {
        method: "GET",
        path: "/api/youtube/stream",
        handler: streamHandler
    },
    // D3. YouTube DASH Manifest
    {
        method: "GET",
        path: "/api/youtube/dash/manifest.mpd",
        handler: dashManifestHandler
    },
    // D4. Auth Check (Public)
    {
        method: "GET",
        path: "/api/auth/check-admin",
        handler: checkAdminEmailHandler
    },
    // D5. Admin API - Cookie Management (Protected)
    {
        method: "GET",
        path: "/api/admin/cookies/status",
        options: {
            pre: [{ method: validateAdminToken }]
        },
        handler: cookieStatusHandler
    },
    {
        method: "POST",
        path: "/api/admin/cookies/upload",
        options: {
            pre: [{ method: validateAdminToken }],
            payload: {
                maxBytes: 1048576, // 1MB for cookies file
                parse: true,
                allow: 'application/json'
            }
        },
        handler: cookieUploadHandler
    },
    {
        method: "POST",
        path: "/api/admin/cookies/validate",
        options: {
            pre: [{ method: validateAdminToken }]
        },
        handler: cookieValidateHandler
    },
    {
        method: "DELETE",
        path: "/api/admin/cookies/clear-cache",
        options: {
            pre: [{ method: validateAdminToken }]
        },
        handler: clearCacheHandler
    },
    // E. Serve the Frontend (from public) - Catch-all/SPA support
    {
        method: "GET",
        path: "/{param*}",
        handler: {
            directory: {
                path: path.join(process.cwd(), 'public'),
                redirectToSlash: true,
                index: true,
            },
        },
    },
    // F. Image Upload API
    {
        method: "POST",
        path: "/api/upload",
        options: {
            payload: {
                maxBytes: 10485760, // 10MB
                output: 'stream',
                parse: true,
                multipart: true
            }
        },
        handler: uploadHandler
    },
    // G. Serve Uploaded Images
    {
        method: "GET",
        path: "/uploads/{param*}",
        handler: {
            directory: {
                path: path.join(process.cwd(), 'uploads'),
                redirectToSlash: true,
                index: false,
            },
        },
    }
];
