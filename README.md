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

2. **Start Development Server**
   ```bash
   npm run dev
   ```
   Runs on `http://localhost:3000` (default) with hot-reload via `nodemon`.

3. **Production Build**
   ```bash
   npm run build
   npm start
   ```

## Key Files
- `server.ts`: Entry point setting up Hapi and WebSocket servers.
- `state.service.ts`: Manages the global application state (current video, paused status, active users).
- `websocket.service.ts`: Handles incoming socket messages and broadcasts updates.
