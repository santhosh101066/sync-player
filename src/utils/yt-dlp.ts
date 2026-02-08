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
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

export const getYtDlpInfo = async (url: string) => {
    try {
        if (infoCache[url]) {
            const entry = infoCache[url];
            if (Date.now() - entry.timestamp < CACHE_TTL) return entry.data;
            delete infoCache[url];
        }

        const args = [
            url,
            '--dump-single-json',
            '--no-warnings',
            '--no-call-home',
            '--flat-playlist',
            '--no-check-certificate',
            '--remote-components', 'ejs:github',
            // '--extractor-args', 'youtube:player_client=ios,android;player_skip=configs,js', // Restricted clients might be hiding adaptive formats
            '--user-agent', UA
        ];

        if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);

        console.log(`[yt-dlp] Fetching info for: ${url}`);
        const { stdout } = await execFileAsync(YTDLP_PATH, args, {
            maxBuffer: 1024 * 1024 * 50,
            env: { ...process.env, LC_ALL: 'en_US.UTF-8' }
        });

        const json = JSON.parse(stdout);
        console.log(`[yt-dlp] Info fetched. Title: ${json.title}, Formats: ${json.formats?.length}`);

        infoCache[url] = { data: json, timestamp: Date.now() };
        return json;
    } catch (error: any) {
        console.error(`[yt-dlp] Error fetching info: ${error.message}`);
        throw new Error(`yt-dlp failed: ${error.message}`);
    }
};
// Helper to spawn a process for piping the stream (Legacy/Direct Pipe)
export const getStreamArgs = (url: string, formatId?: string) => {
    const args = [
        url,
        '--output', '-', // Pipe to stdout
        '--no-part',     // Don't use .part files
        '--no-cache-dir',
        '--no-buffer',
        '--ignore-errors', // Keep processing if something minor fails
    ];

    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }

    if (formatId) {
        args.push('-f', formatId);
    } else {
        // Ultimate Quality Priority & Robust Fallback
        // 1. Sort by resolution, fps, av1, vp9, bitrate
        args.push('-S', 'res,fps,codec:av1,codec:vp9,bitrate');

        // 2. The "Perfect" Format String
        // - Primary: Best Video (mp4) + Best Audio (m4a/opus)
        // - Secondary: Best Video (any) + Best Audio (any) -> will be merged by ffmpeg if needed, but for piping we might need to be careful. 
        // Note: Piping merged formats requires ffmpeg on the system (which we have).
        args.push('-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4] / bv*+ba/b');
    }

    return args;
};

// Helper for file downloads (saving to disk)
export const getDownloadArgs = (url: string, outputDir: string) => {
    const args = [
        url,
        // Professional Naming Convention
        '-o', `${outputDir}/%(title)s [%(height)s] [%(id)s].%(ext)s`,

        // Container Enforcement
        '--merge-output-format', 'mp4',

        // Quality & Fallback
        '-S', 'res,fps,codec:av1,codec:vp9,bitrate',
        '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4] / bv*+ba/b',

        '--ignore-errors',
        '--no-check-certificate', // Only if necessary, but good for stability
        '--no-warnings',

        // Add metadata
        '--add-metadata',
        '--embed-thumbnail',
        '--embed-chapters'
    ];

    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
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
