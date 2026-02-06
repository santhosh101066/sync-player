# Cookie Management API

## Setup

1. Set your admin token in `.env`:
```bash
ADMIN_TOKEN=your-secure-random-token-here
```

2. Generate a secure token (example):
```bash
openssl rand -hex 32
```

## Endpoints

All admin endpoints require authentication via `X-Admin-Token` header or `?token=` query parameter.

### 1. Check Cookie Status

```bash
GET /api/admin/cookies/status
```

**Headers:**
```
X-Admin-Token: your-admin-token
```

**Response:**
```json
{
  "status": "valid",
  "cookiesFound": 20,
  "requiredCookies": {
    "found": ["SID", "__Secure-1PSID", "__Secure-3PSID", "HSID", "SSID", "APISID", "SAPISID"],
    "missing": []
  },
  "soonestExpiry": {
    "name": "SIDCC",
    "expiresAt": "2026-02-15T10:30:00.000Z",
    "expiresInSeconds": 1296000
  },
  "expiringCookies": [...]
}
```

### 2. Upload New Cookies

```bash
POST /api/admin/cookies/upload
Content-Type: application/json
X-Admin-Token: your-admin-token

{
  "cookies": "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\t..."
}
```

**Response:**
```json
{
  "success": true,
  "message": "Cookies updated successfully",
  "cacheCleared": 5
}
```

**Note:** Old cookies are automatically backed up to `cookies.txt.backup.[timestamp]`

### 3. Validate Cookies

```bash
POST /api/admin/cookies/validate
X-Admin-Token: your-admin-token
```

**Response:**
```json
{
  "valid": true,
  "message": "Cookies are working",
  "testVideo": {
    "title": "Me at the zoo",
    "duration": 19,
    "formats": 25
  }
}
```

### 4. Clear Cache

```bash
DELETE /api/admin/cookies/clear-cache
X-Admin-Token: your-admin-token
```

**Response:**
```json
{
  "success": true,
  "message": "Cleared 3 cached entries"
}
```

## Usage Examples

### Using curl

```bash
# Check status
curl -H "X-Admin-Token: your-token" http://localhost:8000/api/admin/cookies/status

# Upload cookies
curl -X POST \
  -H "X-Admin-Token: your-token" \
  -H "Content-Type: application/json" \
  -d '{"cookies":"<paste-netscape-cookies-here>"}' \
  http://localhost:8000/api/admin/cookies/upload

# Validate
curl -X POST \
  -H "X-Admin-Token: your-token" \
  http://localhost:8000/api/admin/cookies/validate

# Clear cache
curl -X DELETE \
  -H "X-Admin-Token: your-token" \
  http://localhost:8000/api/admin/cookies/clear-cache
```

### Using query parameter (alternative)

```bash
curl "http://localhost:8000/api/admin/cookies/status?token=your-token"
```

## Cookie Export Guide

1. Install "Get cookies.txt LOCALLY" browser extension
2. Navigate to youtube.com while logged in
3. Click extension icon → Export cookies
4. Copy the exported text
5. Use the upload endpoint to update cookies

## Troubleshooting

**401 Unauthorized**: Check that ADMIN_TOKEN is set in `.env` and matches your request header/query

**503 Service Unavailable**: ADMIN_TOKEN is not configured in `.env`

**400 Bad Request**: Invalid cookie format (must be Netscape format with tab-separated fields)
