import { Request, ResponseToolkit } from "@hapi/hapi";
import fs from "fs";
import path from "path";

export const libraryHandler = async (request: Request, h: ResponseToolkit) => {
    const dir = path.join(process.cwd(), 'downloads'); // Use CWD for downloads
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir);
            return [];
        }
        const files = await fs.promises.readdir(dir);
        // Filter for common video formats
        const validFiles = files.filter(f => /\.(mp4|mkv|webm|m3u8)$/i.test(f));
        console.log(`[Library] Scanned ${files.length} files. Returning ${validFiles.length} valid videos.`);
        return validFiles;
    } catch (e) {
        console.error("Library scan error:", e);
        return [];
    }
};
