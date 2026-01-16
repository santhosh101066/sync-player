# SyncStream Server

The persistent backend for SyncStream, powered by Hapi.js and WebSockets. It handles real-time state synchronization, user session management, and proxying for video streams.

## Features
- **WebSocket Hub**: Manages all client connections for real-time chat, video state (time/pause), and control commands.
- **State Arbitration**: Maintains the "source of truth" for video playback to ensure late-joiners sync instantly.
- **Stream Proxy**: Built-in proxy service to bypass CORS restrictions for video URLs.
- **Admin Authentication**: Secure handling of admin login and privileged command broadcasting.

## Tech Stack
- **Runtime**: Node.js
- **Framework**: Hapi.js
- **WebSocket**: `ws` library
- **Language**: TypeScript

## Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Environment Configuration**
   Copy the sample env file:
   ```bash
   cp .env.sample .env
   ```

3. **Google API Setup**
   1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
   2. Create a new project or select an existing one.
   3. Navigate to **APIs & Services > Credentials**.
   4. Create **OAuth 2.0 Client ID** credentials.
   5. Add your authorized origins (e.g., `http://localhost:5173`, `https://your-domain.com`).
   6. Copy the **Client ID**.
   7. You will need to add this Client ID to your **UI** environment (`VITE_GOOGLE_CLIENT_ID`).

4. **Cloudflare Tunnel Setup**
   To expose your local server to the internet securely:
   1. Install `cloudflared`.
   2. Authenticate: `cloudflared tunnel login`.
   3. Create a tunnel: `cloudflared tunnel create syncplayer`.
   4. Configure the tunnel to point to your local server port (default 8000):
      ```yaml
      # config.yml
      tunnel: <Tunnel-UUID>
      credentials-file: /path/to/creds.json

      ingress:
        - hostname: your-domain.com
          service: http://localhost:8000
        - service: http_status:404
      ```
   5. Run the tunnel:
      ```bash
      cloudflared tunnel run syncplayer
      ```

5. **Start Development Server**
   ```bash
   npm run dev
   ```
   Runs on `http://localhost:8000` (default) with hot-reload via `nodemon`.

6. **Production Build**
   ```bash
   npm run build
   npm start
   ```

## Key Files
- `server.ts`: Entry point setting up Hapi and WebSocket servers.
- `state.service.ts`: Manages the global application state (current video, paused status, active users).
- `websocket.service.ts`: Handles incoming socket messages and broadcasts updates.
