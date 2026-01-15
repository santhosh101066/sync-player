import { ServerRoute } from "@hapi/hapi";
import path from "path";
import { libraryHandler } from "./handlers/library.handler";
import { proxyPlaylistHandler, proxyStreamHandler } from "./handlers/proxy.handler";
import { uploadHandler } from "./handlers/upload.handler";

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
