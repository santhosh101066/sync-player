import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

// Ensure cookies path is absolute
const COOKIES_PATH = path.join(__dirname, "../../cookies.txt");
// Use local standalone binary
const YTDLP_PATH = path.join(__dirname, "../../bin/yt-dlp");

const execFileAsync = promisify(execFile);

// Simple In-Memory Cache
const CACHE_TTL = 3600 * 1000; // 1 hour
const infoCache: Record<string, { data: any, timestamp: number }> = {};

// Use a fixed User-Agent to match Axios and avoid client mismatch issues
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const getYtDlpInfo = async (url: string) => {
    try {
        // Check Cache
        if (infoCache[url]) {
            const entry = infoCache[url];
            if (Date.now() - entry.timestamp < CACHE_TTL) {
                // console.log("[yt-dlp] Returning cached info");
                return entry.data;
            }
            delete infoCache[url];
        }

        // Direct spawn of binary to bypass node wrapper trying to use python
        const args = [
            url,
            '--dump-single-json',
            '--no-warnings',
            '--no-call-home',
            '--prefer-free-formats',
            '--no-check-certificate', // Sometimes needed for older environments/proxies
            // CRITICAL: Force User-Agent to match what we use in Axios
            // Remove 'player_client' to allow all formats (1080p), but use UA to pass bot check
            '--user-agent', UA
        ];

        if (fs.existsSync(COOKIES_PATH)) {
            args.push('--cookies', COOKIES_PATH);
        }

        const { stdout } = await execFileAsync(YTDLP_PATH, args, {
            maxBuffer: 1024 * 1024 * 20, // 20MB buffer
            env: { ...process.env, LC_ALL: 'en_US.UTF-8' }
        });

        const json = JSON.parse(stdout);

        // Cache success
        infoCache[url] = { data: json, timestamp: Date.now() };

        return json;
    } catch (error: any) {
        console.error("[yt-dlp] Info fetch error:", error.message);
        if (error.stderr) console.error("[yt-dlp] Stderr:", error.stderr);
        throw error;
    }
};

// Helper to spawn a process for piping the stream (Legacy/Direct Pipe)
export const getStreamArgs = (url: string, formatId?: string, range?: string) => {
    const args = [
        url,
        '--output', '-', // Pipe to stdout
        '--no-part',     // Don't use .part files
        '--no-cache-dir',
        '--no-buffer'
    ];

    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }

    if (formatId) {
        args.push('-f', formatId);
    } else {
        // Fallback default
        args.push('-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4] / hv*[ext=mp4]+wa[ext=m4a]');
    }

    return args;
};

// Clear the in-memory cache (useful when cookies are updated)
export const clearCache = () => {
    const keys = Object.keys(infoCache);
    keys.forEach(key => delete infoCache[key]);
    console.log(`[yt-dlp] Cleared ${keys.length} cached entries`);
    return keys.length;
};
