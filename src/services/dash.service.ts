import { getMp4Ranges, Mp4Ranges } from "../utils/mp4-parser";
import { getCookiesHeader } from "../utils/cookies";

export class DashManifestService {

    private static escapeXml(str: string): string {
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
    }

    private static getBase64Url(url: string, referer?: string, headers?: Record<string, string>): string {
        const b64Url = Buffer.from(url).toString('base64');
        let final = `/api/proxy/stream?url=${b64Url}`;
        if (referer) {
            final += `&ref=${Buffer.from(referer).toString('base64')}`;
        }
        if (headers && Object.keys(headers).length > 0) {
            final += `&headers=${Buffer.from(JSON.stringify(headers)).toString('base64')}`;
        }
        return final;
    }

    public static async generateManifest(videoId: string, info: any): Promise<string> {
        const duration = info.duration;
        const formats: any[] = info.formats || [];

        // Extract Global Cookies/Headers
        const globalCookies = getCookiesHeader('youtube.com'); // from disk, filtered for youtube
        const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

        // Prepare headers for proxy
        const proxyHeaders: Record<string, string> = {
            'User-Agent': ua,
            'Origin': 'https://www.youtube.com'
        };
        if (globalCookies) {
            proxyHeaders['Cookie'] = globalCookies.replace(/[\r\n]/g, '');
        }

        console.log(`[DASH] Generating manifest for ${videoId}. Total formats: ${formats.length}`);

        // Debug: Log format summaries
        formats.forEach((f: any, i: number) => {
            console.log(`[DASH] Fmt[${i}]: id=${f.format_id} ext=${f.ext} res=${f.height} video=${f.vcodec} audio=${f.acodec} note=${f.format_note}`);
        });

        // Filter and Sort Video Formats
        // We want adaptive video formats (mp4, no audio)
        const videoFormats = formats.filter((f: any) =>
            f.vcodec !== 'none' &&
            f.acodec === 'none' &&
            f.ext === 'mp4'
        ).sort((a: any, b: any) => (b.height || 0) - (a.height || 0)); // Highest res first

        console.log(`[DASH] Found ${videoFormats.length} suitable video formats (mp4, video-only).`);

        // Filter Audio Formats
        const audioFormats = formats.filter((f: any) =>
            f.acodec !== 'none' &&
            f.vcodec === 'none' &&
            (f.ext === 'm4a' || f.ext === 'mp4') // dash usually uses m4a/mp4 containers
        );

        console.log(`[DASH] Found ${audioFormats.length} suitable audio formats.`);

        let mpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" minBufferTime="PT1.5S" type="static" mediaPresentationDuration="PT${duration}S">
  <Period>`;

        // Helper to process a list of formats (video or audio)
        const processAdaptationSet = async (formatList: any[], mimeType: string) => {
            if (formatList.length === 0) {
                console.warn(`[DASH] No formats found for ${mimeType}`);
                return "";
            }

            let adaptationSet = `    <AdaptationSet mimeType="${mimeType}" subsegmentAlignment="true" startWithSAP="1">`;

            // Limit to top quality items to speed up generation if needed, 
            // but for adaptive streaming we usually want options. 
            // Let's take top 5 video and all audio.
            const targetFormats = mimeType.startsWith("video") ? formatList.slice(0, 6) : formatList;

            let addedCount = 0;
            for (const f of targetFormats) {
                let indexRange = f.index_range;
                let initRange = f.init_range;
                const itag = f.format_id;

                // Fallback: Parse atoms if missing
                if (!indexRange || !initRange) {
                    // Try parsing
                    const ytHeaders = f.http_headers || info.http_headers || {};
                    // Ensure we pass cookies if they are in the headers or separate
                    if (info.cookies) {
                        // Should be in http_headers already if properly dumped
                    }

                    const ranges = await getMp4Ranges(f.url, ytHeaders);
                    if (ranges) {
                        indexRange = ranges.index;
                        initRange = ranges.init;
                    } else {
                        console.warn(`[DASH] Failed to parse ranges for ${itag} (${mimeType})`);
                    }
                }

                if (!indexRange || !initRange) {
                    continue;
                }

                // Construct Proxy URL
                // Use root-relative URL to avoid mixed content/host issues behind proxies (Cloudflare)
                const proxyUrl = `/api/youtube/stream?id=${videoId}&itag=${itag}`;

                const bandwidth = f.tbr ? Math.round(f.tbr * 1000) : (f.filesize ? Math.round(f.filesize * 8 / duration) : 1000000);
                const widthAttr = f.width ? `width="${f.width}"` : "";
                const heightAttr = f.height ? `height="${f.height}"` : "";
                const codecs = f.vcodec !== 'none' ? f.vcodec : f.acodec;

                adaptationSet += `
      <Representation id="${itag}" bandwidth="${bandwidth}" codecs="${codecs}" ${widthAttr} ${heightAttr}>
        <BaseURL>${this.escapeXml(proxyUrl)}</BaseURL>
        <SegmentBase indexRange="${indexRange.start}-${indexRange.end}">
          <Initialization range="${initRange.start}-${initRange.end}" />
        </SegmentBase>
      </Representation>`;
                addedCount++;
            }

            if (addedCount === 0) {
                console.warn(`[DASH] All formats for ${mimeType} skipped due to missing ranges.`);
                return "";
            }

            adaptationSet += `\n    </AdaptationSet>`;
            return adaptationSet;
        };

        const [videoSet, audioSet] = await Promise.all([
            processAdaptationSet(videoFormats, "video/mp4"),
            processAdaptationSet(audioFormats, "audio/mp4")
        ]);

        mpd += `\n${videoSet}\n${audioSet}\n  </Period>\n</MPD>`;
        return mpd;
    }
}
