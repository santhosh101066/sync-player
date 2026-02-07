import crypto from 'crypto';

/**
 * Generates a consistent SHA-256 hash from a Google ID.
 * This ensures the same user always gets the same unique identifier across sessions.
 * 
 * @param googleId - The Google user's unique identifier (sub field from JWT)
 * @returns A 64-character hexadecimal hash string
 */
export function hashGoogleId(googleId: string): string {
    return crypto
        .createHash('sha256')
        .update(googleId)
        .digest('hex');
}
