import { Request, ResponseToolkit } from "@hapi/hapi";
import { getYtDlpInfo } from "../utils/yt-dlp";
import { DashManifestService } from "../services/dash.service";

export const dashManifestHandler = async (request: Request, h: ResponseToolkit) => {
    const id = request.query.id as string;
    if (!id) return h.response({ error: "No ID provided" }).code(400);

    const videoUrl = `https://www.youtube.com/watch?v=${id}`;

    try {
        console.log(`[DASH] Handling request for ID: ${id}`);
        // 1. Get Info from yt-dlp
        const info = await getYtDlpInfo(videoUrl) as any;

        // 2. Generate Manifest via Service (using relative URLs)
        const mpd = await DashManifestService.generateManifest(id, info);

        return h.response(mpd)
            .type('application/dash+xml')
            .header('Access-Control-Allow-Origin', '*')
            .header('Cache-Control', 'no-cache');

    } catch (error: any) {
        console.error("[DASH] Manifest generation failed:", error.message);
        return h.response({ error: "DASH generation failed" }).code(500);
    }
};