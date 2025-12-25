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
        return files.filter(f => /\.(mp4|mkv|webm|m3u8)$/i.test(f));
    } catch (e) {
        console.error("Library scan error:", e);
        return [];
    }
};
