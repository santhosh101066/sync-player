import fs from "fs";
import path from "path";

const COOKIES_PATH = path.join(__dirname, "../../cookies.txt");

export const getCookiesHeader = (): string | null => {
    const cookiesPath = path.join(__dirname, "../../cookies.txt");
    if (!fs.existsSync(cookiesPath)) {
        return null;
    }

    try {
        const content = fs.readFileSync(cookiesPath, "utf-8");
        const lines = content.split("\n").filter(line => line.trim() && !line.startsWith("#"));

        const cookies = lines.map(line => {
            const parts = line.split("\t");
            if (parts.length >= 7) {
                const name = parts[5];
                const value = parts[6];
                return `${name}=${value}`;
            }
            return null;
        }).filter(c => c !== null);

        return cookies.join("; ");
    } catch (e) {
        console.error("[Cookies] Failed to read cookies:", e);
        return null;
    }
};

// Parse cookie expiration dates from cookies.txt
export const parseCookieExpiration = (): { name: string, expires: number, expiresDate: Date }[] => {
    const cookiesPath = path.join(__dirname, "../../cookies.txt");
    if (!fs.existsSync(cookiesPath)) {
        return [];
    }

    try {
        const content = fs.readFileSync(cookiesPath, "utf-8");
        const lines = content.split("\n").filter(line => line.trim() && !line.startsWith("#"));

        return lines.map(line => {
            const parts = line.split("\t");
            if (parts.length >= 7) {
                const name = parts[5];
                const expires = parseInt(parts[4], 10);
                return {
                    name,
                    expires,
                    expiresDate: new Date(expires * 1000)
                };
            }
            return null;
        }).filter(c => c !== null) as { name: string, expires: number, expiresDate: Date }[];
    } catch (e) {
        console.error("[Cookies] Failed to parse expiration:", e);
        return [];
    }
};

// Check if cookies.txt has required YouTube authentication cookies
export const getRequiredCookies = (): { found: string[], missing: string[] } => {
    const required = ['SID', '__Secure-1PSID', '__Secure-3PSID', 'HSID', 'SSID', 'APISID', 'SAPISID'];
    const cookiesPath = path.join(__dirname, "../../cookies.txt");

    if (!fs.existsSync(cookiesPath)) {
        return { found: [], missing: required };
    }

    try {
        const content = fs.readFileSync(cookiesPath, "utf-8");
        const lines = content.split("\n").filter(line => line.trim() && !line.startsWith("#"));

        const foundCookies = lines.map(line => {
            const parts = line.split("\t");
            if (parts.length >= 7) {
                return parts[5];
            }
            return null;
        }).filter(c => c !== null) as string[];

        const found = required.filter(r => foundCookies.includes(r));
        const missing = required.filter(r => !foundCookies.includes(r));

        return { found, missing };
    } catch (e) {
        console.error("[Cookies] Failed to check required cookies:", e);
        return { found: [], missing: required };
    }
};

// Validate Netscape cookie format
export const validateCookieFormat = (content: string): { valid: boolean, error?: string } => {
    const lines = content.split("\n").filter(line => line.trim() && !line.startsWith("#"));

    if (lines.length === 0) {
        return { valid: false, error: "No cookies found in file" };
    }

    for (let i = 0; i < lines.length; i++) {
        const parts = lines[i].split("\t");
        if (parts.length < 7) {
            return { valid: false, error: `Invalid format at line ${i + 1}: expected 7 tab-separated fields` };
        }
    }

    return { valid: true };
};
