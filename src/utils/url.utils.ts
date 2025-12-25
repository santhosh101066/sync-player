export function assertHttpUrl(raw: string) {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error("Only http/https URLs are allowed");
    }
    return u;
}

export function getProxiedUrl(url: string, referer?: string): string {
    const b64url = Buffer.from(url).toString('base64');
    if (referer) {
        const b64ref = Buffer.from(referer).toString('base64');
        return `/api/proxy/stream?url=${b64url}&ref=${b64ref}`;
    }
    return `/api/proxy/stream?url=${b64url}`;
}
