import ytdl from "@distube/ytdl-core";
import fs from "fs";
import path from "path";

let agent: ytdl.Agent | undefined;

export const getYtdlAgent = (): ytdl.Agent => {
    if (agent) return agent;

    const cookiesPath = path.join(__dirname, "../../cookies.txt");

    if (fs.existsSync(cookiesPath)) {
        try {
            // Check if file has content
            const content = fs.readFileSync(cookiesPath, 'utf-8').trim();
            if (content.length > 10) {
                console.log("[YTDL-Agent] Loading cookies from cookies.txt");

                let cookies: { name: string, value: string }[] = [];

                // Detect Format
                // Netscape usually has 7 tab-separated columns
                if (content.includes('\t') && content.split('\n').some(l => l.split('\t').length >= 6)) {
                    // Netscape Format
                    cookies = content.split('\n')
                        .filter(line => line.length > 0 && !line.startsWith('#'))
                        .map(line => {
                            const parts = line.split('\t');
                            if (parts.length >= 6) {
                                return {
                                    name: parts[5],
                                    value: parts[6].replace('\r', '').trim()
                                };
                            }
                            return null;
                        })
                        .filter(c => c !== null) as { name: string, value: string }[];
                } else {
                    // Raw Cookie Header String (e.g. "key=value; key2=value2")
                    // Basic parsing
                    cookies = content.split(';')
                        .map(part => {
                            const [name, ...valParts] = part.trim().split('=');
                            if (name && valParts.length > 0) {
                                return {
                                    name: name.trim(),
                                    value: valParts.join('=').trim()
                                };
                            }
                            return null;
                        })
                        .filter(c => c !== null) as { name: string, value: string }[];
                }

                if (cookies.length > 0) {
                    console.log(`[YTDL-Agent] Loaded ${cookies.length} cookies.`);
                    agent = ytdl.createAgent(cookies);
                    return agent;
                }
            }
        } catch (e) {
            console.error("[YTDL-Agent] Failed to load cookies:", e);
        }
    }

    console.log("[YTDL-Agent] No cookies found or valid, using default agent.");
    agent = ytdl.createAgent(); // Default
    return agent;
};
