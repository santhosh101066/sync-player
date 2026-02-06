import ytdl from "@distube/ytdl-core";

const id = "BciiXULbAuo"; // Example video
const url = `https://www.youtube.com/watch?v=${id}`;

async function run() {
    console.log("Fetching info for:", url);
    try {
        const info = await ytdl.getInfo(url);
        const details = info.videoDetails as any;

        console.log("Title:", details.title);

        // Check for manifests
        console.log("DASH Manifest URL:", details.dashManifestUrl || "None");
        console.log("HLS Manifest URL:", details.hlsManifestUrl || "None");

        // Check adaptive formats
        const adaptive = info.formats.filter(f => !f.hasAudio && f.hasVideo);
        console.log(`Found ${adaptive.length} adaptive video formats`);
        adaptive.forEach(f => {
            console.log(`- ${f.qualityLabel} (${f.container}) codecs=${f.videoCodec} bitrate=${f.bitrate}`);
            console.log(`  indexRange: ${f.indexRange ? JSON.stringify(f.indexRange) : 'N/A'}`);
            console.log(`  initRange: ${f.initRange ? JSON.stringify(f.initRange) : 'N/A'}`);
        });

        const audio = info.formats.filter(f => f.hasAudio && !f.hasVideo);
        console.log(`Found ${audio.length} adaptive audio formats`);
        audio.forEach(f => {
            console.log(`- ${f.audioBitrate}kbps (${f.container}) codecs=${f.audioCodec}`);
        });

    } catch (e) {
        console.error("Error:", e);
    }
}

run();
