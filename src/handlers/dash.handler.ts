import { Request, ResponseToolkit } from "@hapi/hapi";
import { getYtDlpInfo } from "../utils/yt-dlp";
import { getMp4Ranges, Mp4Ranges } from "../utils/mp4-parser";
import { getCookiesHeader } from "../utils/cookies";

// Helper to escape XML special chars
const xmlEscape = (str: string) => {
    return str.replace(/[<>&'"]/g, (c) => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
            default: return c;
        }
    });
};

// In-memory cache for ranges to avoid re-fetching 
// (Simple map, in production use Redis or LRU)
const rangesCache: Record<string, Mp4Ranges> = {};

export const dashManifestHandler = async (request: Request, h: ResponseToolkit) => {
    const id = request.query.id as string;
    if (!id) return h.response({ error: "No ID provided" }).code(400);
    const videoUrl = `https://www.youtube.com/watch?v=${id}`;

    try {
        const info = await getYtDlpInfo(videoUrl) as any;
        const duration = info.duration;
        const formats: any[] = info.formats || [];

        // Filter Formats
        // yt-dlp: video only => vcodec!='none' && acodec=='none'
        let videoFormats = formats.filter(f => f.vcodec !== 'none' && f.acodec === 'none');
        // Filter for MP4 container (best for DASH compatibility in browsers)
        const mp4Videos = videoFormats.filter(f => f.ext === 'mp4');
        if (mp4Videos.length > 0) videoFormats = mp4Videos;

        // Audio only => acodec!='none' && vcodec=='none'
        let audioFormats = formats.filter(f => f.acodec !== 'none' && f.vcodec === 'none');
        const mp4Audios = audioFormats.filter(f => f.ext === 'm4a' || f.ext === 'mp4');
        if (mp4Audios.length > 0) audioFormats = mp4Audios;

        let mpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" minBufferTime="PT1.5S" type="static" mediaPresentationDuration="PT${duration}S">
  <Period>
`;

        // Function to process a format list and add to MPD
        const processFormats = async (formatList: any[], mimeType: string) => {
            if (formatList.length === 0) return "";
            let sets = `    <AdaptationSet mimeType="${mimeType}" subsegmentAlignment="true" startWithSAP="1">\n`;

            // Limit to top 5 formats to avoid timeout
            const limitedFormats = formatList.slice(0, 5);
            let successCount = 0;

            for (const f of limitedFormats) {
                // Skip if we already have enough successful formats
                if (successCount >= 3) break;

                let indexRange = f.index_range;
                let initRange = f.init_range;
                const itag = f.format_id;



                // ...

                // If ranges missing, try to fetch/parse with timeout
                if (!indexRange || !initRange) {
                    const cacheKey = `${id}-${itag}`;
                    if (rangesCache[cacheKey]) {
                        indexRange = rangesCache[cacheKey].index;
                        initRange = rangesCache[cacheKey].init;
                    } else if (f.url) {
                        try {
                            // Only fetch if we haven't already
                            console.log(`[DASH] Parsing ranges for itag ${itag}...`);
                            const cookies = getCookiesHeader() || undefined;

                            // Use Promise.race to timeout after 3 seconds
                            const ranges = await Promise.race([
                                getMp4Ranges(f.url, cookies),
                                new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))
                            ]);

                            if (ranges) {
                                rangesCache[cacheKey] = ranges;
                                indexRange = ranges.index;
                                initRange = ranges.init;
                                console.log(`[DASH] Ranges found for itag ${itag}: Init ${initRange.start}-${initRange.end}, Index ${indexRange.start}-${indexRange.end}`);
                            } else {
                                console.warn(`[DASH] Parser timeout or failed for itag ${itag}`);
                                continue; // Skip this format
                            }
                        } catch (e) {
                            console.warn(`[DASH] Failed to parse ranges for itag ${itag}:`, e);
                            continue; // Skip this format
                        }
                    }
                }

                if (!indexRange || !initRange) continue;

                successCount++;

                const width = f.width || 0;
                const height = f.height || 0;
                const bitrate = f.tbr ? Math.round(f.tbr * 1000) : (f.abr || 0) * 1000;
                // Codec fallbacks
                let codec = f.vcodec;
                if (!codec || codec === 'none') codec = f.acodec || "mp4a.40.2";
                if (codec === 'none') codec = "avc1.4d401e"; // Fallback generic


                // Build proxy URL using the request's host (supports localhost, domains, tunnels)
                const protocol = request.headers['x-forwarded-proto'] || (request.server.info.protocol === 'http' ? 'http' : 'https');
                const host = request.headers['x-forwarded-host'] || request.headers.host || request.info.host;
                const proxyUrl = `${protocol}://${host}/api/youtube/stream?id=${id}&itag=${itag}`;


                sets += `      <Representation id="${itag}" bandwidth="${bitrate}" codecs="${codec}"`;
                if (width > 0) sets += ` width="${width}" height="${height}"`;
                sets += `>\n`;
                sets += `        <BaseURL>${xmlEscape(proxyUrl)}</BaseURL>\n`;
                sets += `        <SegmentBase indexRange="${indexRange.start}-${indexRange.end}">\n`;
                sets += `          <Initialization range="${initRange.start}-${initRange.end}" />\n`;
                sets += `        </SegmentBase>\n`;
                sets += `      </Representation>\n`;
            }
            sets += `    </AdaptationSet>\n`;
            return sets;
        };

        // We use Promise.all to fetch ranges in parallel for speed
        // Careful with too many requests, but 5-10 formats is fine
        const [videoSet, audioSet] = await Promise.all([
            processFormats(videoFormats, "video/mp4"),
            processFormats(audioFormats, "audio/mp4")
        ]);

        mpd += videoSet;
        mpd += audioSet;

        mpd += `  </Period>
  <!-- Debug Info -->
  <!-- Cookies Loaded: ${!!getCookiesHeader()} -->
  <!-- Video Formats Found: ${videoFormats.length} -->
  <!-- Audio Formats Found: ${audioFormats.length} -->
</MPD>`;

        return h.response(mpd).type('application/dash+xml').header('Access-Control-Allow-Origin', '*');

    } catch (error: any) {
        console.error("[DASH] Error:", error.message);
        return h.response({ error: "DASH generation failed" }).code(500);
    }
};
