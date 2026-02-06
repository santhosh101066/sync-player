import { getYtDlpInfo } from "../src/utils/yt-dlp";

async function run() {
    const id = "P-BDQpd6nkA";
    console.log(`Getting info for ID: ${id}`);
    try {
        const info = await getYtDlpInfo(`https://www.youtube.com/watch?v=${id}`) as any;
        console.log(`Title: ${info.title}`);

        if (info.formats) {
            console.log(`Found ${info.formats.length} formats.`);
            const ids = info.formats.map((f: any) => f.format_id);
            console.log("Format IDs:", ids.join(", "));

            const f137 = info.formats.find((f: any) => f.format_id === '137');
            console.log("Has 137:", !!f137);
        }

    } catch (e) {
        console.error("Error:", e);
    }
}

run();
