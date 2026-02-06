import { Request, ResponseToolkit } from "@hapi/hapi";
import fs from "fs";
import path from "path";
import { parseCookieExpiration, getRequiredCookies, validateCookieFormat } from "../utils/cookies";
import { clearCache, getYtDlpInfo } from "../utils/yt-dlp";

const COOKIES_PATH = path.join(__dirname, "../../cookies.txt");

// Simple token-based auth middleware
const validateAdminToken = (request: Request, h: ResponseToolkit) => {
    const token = request.headers['x-admin-token'] || request.query.token;
    const adminToken = process.env.ADMIN_TOKEN;

    if (!adminToken) {
        return h.response({ error: "Admin endpoints disabled (ADMIN_TOKEN not set)" }).code(503);
    }

    if (token !== adminToken) {
        return h.response({ error: "Unauthorized" }).code(401).takeover();
    }

    return h.continue;
};

// GET /api/admin/cookies/status
export const cookieStatusHandler = async (request: Request, h: ResponseToolkit) => {
    try {
        const expirations = parseCookieExpiration();
        const required = getRequiredCookies();
        const now = Date.now();

        // Find soonest expiring cookie
        const expiringSoon = expirations
            .filter(c => c.expires > 0) // Ignore session cookies (expires = 0)
            .sort((a, b) => a.expires - b.expires);

        const soonestExpiry = expiringSoon[0];
        const isExpired = soonestExpiry && soonestExpiry.expires * 1000 < now;
        const expiresIn = soonestExpiry ? Math.floor((soonestExpiry.expires * 1000 - now) / 1000) : null;

        return h.response({
            status: isExpired ? "expired" : required.missing.length > 0 ? "incomplete" : "valid",
            cookiesFound: expirations.length,
            requiredCookies: required,
            soonestExpiry: soonestExpiry ? {
                name: soonestExpiry.name,
                expiresAt: soonestExpiry.expiresDate.toISOString(),
                expiresInSeconds: expiresIn
            } : null,
            expiringCookies: expiringSoon.slice(0, 5).map(c => ({
                name: c.name,
                expiresAt: c.expiresDate.toISOString()
            }))
        }).code(200);
    } catch (error: any) {
        console.error("[Admin] Cookie status error:", error.message);
        return h.response({ error: "Failed to check cookie status" }).code(500);
    }
};

// POST /api/admin/cookies/upload
export const cookieUploadHandler = async (request: Request, h: ResponseToolkit) => {
    try {
        const payload = request.payload as any;

        if (!payload || !payload.cookies) {
            return h.response({ error: "Missing 'cookies' field in request body" }).code(400);
        }

        const content = payload.cookies;

        // Validate format
        const validation = validateCookieFormat(content);
        if (!validation.valid) {
            return h.response({ error: validation.error }).code(400);
        }

        // Backup existing cookies
        if (fs.existsSync(COOKIES_PATH)) {
            const backupPath = `${COOKIES_PATH}.backup.${Date.now()}`;
            fs.copyFileSync(COOKIES_PATH, backupPath);
            console.log(`[Admin] Backed up cookies to ${backupPath}`);
        }

        // Write new cookies
        fs.writeFileSync(COOKIES_PATH, content, "utf-8");
        console.log("[Admin] Cookies updated successfully");

        // Clear cache to force fresh requests
        const cleared = clearCache();

        return h.response({
            success: true,
            message: "Cookies updated successfully",
            cacheCleared: cleared
        }).code(200);
    } catch (error: any) {
        console.error("[Admin] Cookie upload error:", error.message);
        return h.response({ error: "Failed to upload cookies" }).code(500);
    }
};

// POST /api/admin/cookies/validate
export const cookieValidateHandler = async (request: Request, h: ResponseToolkit) => {
    try {
        // Test with a known video
        const testUrl = "https://www.youtube.com/watch?v=jNQXAC9IVRw"; // "Me at the zoo" - first YouTube video

        console.log("[Admin] Testing cookies with sample video...");
        const info = await getYtDlpInfo(testUrl) as any;

        if (info && info.title) {
            return h.response({
                valid: true,
                message: "Cookies are working",
                testVideo: {
                    title: info.title,
                    duration: info.duration,
                    formats: info.formats?.length || 0
                }
            }).code(200);
        } else {
            return h.response({
                valid: false,
                message: "Failed to fetch video info (cookies may be invalid)"
            }).code(200);
        }
    } catch (error: any) {
        console.error("[Admin] Cookie validation error:", error.message);

        // Check if error is cookie-related
        const isCookieError = error.message?.includes("Sign in") || error.message?.includes("bot");

        return h.response({
            valid: false,
            message: isCookieError ? "Cookie authentication failed" : "Validation failed",
            error: error.message
        }).code(200);
    }
};

// DELETE /api/admin/cookies/clear-cache
export const clearCacheHandler = async (request: Request, h: ResponseToolkit) => {
    try {
        const cleared = clearCache();
        return h.response({
            success: true,
            message: `Cleared ${cleared} cached entries`
        }).code(200);
    } catch (error: any) {
        console.error("[Admin] Clear cache error:", error.message);
        return h.response({ error: "Failed to clear cache" }).code(500);
    }
};

export { validateAdminToken };
