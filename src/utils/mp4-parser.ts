import axios from "axios";

export interface Mp4Ranges {
    init: { start: number; end: number };
    index: { start: number; end: number };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

export const getMp4Ranges = async (url: string, customHeaders?: Record<string, string>): Promise<Mp4Ranges | null> => {
    try {
        const headers: any = {
            'Range': 'bytes=0-65535',
            'User-Agent': UA,
            'Accept': '*/*',
            'Connection': 'keep-alive',
            ...customHeaders
        };

        // Fetch first 64KB to find atoms
        const response = await axios.get(url, {
            headers: headers,
            responseType: 'arraybuffer',
            timeout: 10000,
            validateStatus: () => true // handled below
        });

        if (response.status >= 400) {
            console.error(`[Mp4Parser] Failed with status ${response.status}: ${response.statusText}`);
            // console.error(`[Mp4Parser] Response body:`, response.data.toString('utf8').substring(0, 200));
            return null;
        }

        const buffer = Buffer.from(response.data);
        let offset = 0;
        let initStart = 0;
        let initEnd = 0;
        let indexStart = 0;
        let indexEnd = 0;

        // Simple atom walker
        while (offset < buffer.length - 8) {
            const size = buffer.readUInt32BE(offset);
            const typeBuffer = buffer.subarray(offset + 4, offset + 8);
            const type = typeBuffer.toString('ascii');

            // console.log(`Atom: ${type} at ${offset}, size: ${size}`);

            if (size === 0) break; // extending to end of file, rare for headers
            if (size === 1) {
                // extended size, 64-bit, not handling here for headers usually
                offset += 8 + 8;
                continue;
            }

            const atomEnd = offset + size - 1;

            if (type === 'ftyp') {
                // Usually part of init
            } else if (type === 'moov') {
                // Movie metadata -> Initialization segment
                // Init range usually includes ftyp + moov
                // If moov comes before sidx, update initEnd
                initEnd = atomEnd;
            } else if (type === 'sidx') {
                // Segment Index -> Index segment
                indexStart = offset;
                indexEnd = atomEnd;
            }

            offset += size;
        }

        // If sidx found, index range is set.
        // Init range is usually 0 to start of sidx - 1 (if sidx follows moov)
        // OR 0 to end of moov (if moov follows sidx? rare)

        // Standard YouTube DASH info:
        // Init: ftyp + moov
        // Index: sidx

        if (indexStart > 0 && initEnd > 0) {
            // Correct logic:
            // Init is everything before Index usually?
            // Actually, sometimes sidx comes before moov in CMAF.
            // YouTube usually: ftyp (small) ... moov (huge) ... sidx (small) ... mdat
            // Wait, YouTube `init_range` usually covers `ftyp` + `moov`.
            // `index_range` covers `sidx`.

            // If we found both:
            return {
                init: { start: 0, end: initEnd },
                index: { start: indexStart, end: indexEnd }
            };
        }

        // Fallback: if we found sidx but not explicitly 'moov' ending (maybe moov is huge > 32KB?)
        // If 'moov' is huge, we might fail. 32KB might be too small for 1080p moov?
        // Let's hope moov is reasonably sized or comes later?
        // Actually, for fragmented files, moov is usually small.

        return null;

    } catch (e: any) {
        console.error("[Mp4Parser] Error:", e.response?.data?.toString('utf8'));
        return null;
    }
}
