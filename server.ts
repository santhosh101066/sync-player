import Hapi from "@hapi/hapi";
import Inert from "@hapi/inert";
import axios from "axios";
import { IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import fs from "fs";
import path from "path";
import internal from "stream";


// ==== 1. Proxy Helper Functions ====
// These functions help rewrite M3U8 playlists so they point back to our proxy
// ensuring CORS issues are bypassed for external HLS streams.
let areUserControlsAllowed = false;

let currentVideoState = {
  url: "",
  time: 0,
  paused: true,
  timestamp: Date.now() // When this state was recorded
};

function assertHttpUrl(raw: string) {
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

// ==== 2. Server Setup ====

const init = async () => {
  const server = Hapi.server({
    port: 8000,
    host: "0.0.0.0",
    routes: {
      cors: {
        origin: ["*"], // In production, restrict this. For dev, * is fine or specific ports.
        additionalHeaders: ["cache-control", "x-requested-with"]
      },
      files: {
        relativeTo: __dirname
      }
    },
  });

  await server.register(Inert);

  // ==== 3. Routes ====

  server.route([
    // B. Library API (Scans /downloads folder)
    {
      method: "GET",
      path: "/api/library",
      handler: async (request, h) => {
        const dir = path.join(__dirname, 'downloads');
        try {
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir);
            return [];
          }
          const files = await fs.promises.readdir(dir);
          // Filter for common video formats
          const videos = files.filter(f => /\.(mp4|mkv|webm|m3u8)$/i.test(f));
          return videos;
        } catch (e) {
          console.error("Library scan error:", e);
          return [];
        }
      }
    },
    // C. Static File Serving for downloaded videos
    {
      method: "GET",
      path: "/downloads/{param*}",
      handler: {
        directory: {
          path: path.join(__dirname, 'downloads'),
          redirectToSlash: true,
          index: false,
        },
      },
    },
    // D. Stream Proxy (Handles chunks/segments)
    {
      method: 'GET',
      path: '/api/proxy/stream',
      handler: async (request, h) => {
        const { url, ref } = request.query;
        if (!url) return h.response({ error: 'No URL' }).code(400);

        try {
          const decodedUrl = Buffer.from(url, 'base64').toString('utf-8');
          const referer = ref ? Buffer.from(ref, 'base64').toString('utf-8') : undefined;

          // Forward specific headers to mimic a browser request
          const requestHeaders: Record<string, string | undefined> = {
            'Referer': referer,
            'User-Agent': request.headers['user-agent'],
            'Accept': request.headers['accept'],
            'Accept-Encoding': request.headers['accept-encoding'],
          };
          if (request.headers.range) requestHeaders['Range'] = request.headers.range;

          const response = await axios.get(decodedUrl, {
            responseType: 'stream',
            headers: requestHeaders,
            validateStatus: () => true,
            decompress: false, // Disable auto-decompression to forward raw stream and headers (Content-Length)
          });

          const stream = response.data as IncomingMessage;
          const hapiResponse = h.response(stream).code(response.status);

          // Forward response headers (Content-Type, Length, etc.)
          const headersToCopy = [
            'content-type', 'content-length', 'accept-ranges',
            'content-range', 'date', 'last-modified', 'etag',
          ];

          for (const [key, value] of Object.entries(response.headers)) {
            if (value && headersToCopy.includes(key.toLowerCase())) {
              hapiResponse.header(key, value.toString());
            }
          }
          return hapiResponse;
        } catch (error: any) {
          console.error('[/proxy/stream] error:', error.message || error);
          return h.response({ error: 'Upstream error' }).code(500);
        }
      },
    },
    // E. M3U8 Playlist Proxy (Rewrites internal URLs)
    {
      method: "GET",
      path: "/api/proxy",
      handler: async (request, h) => {
        try {
          const { url, ref } = request.query;
          if (!url) return h.response({ error: "No URL" }).code(400);

          const decodedUrl = Buffer.from(url, "base64").toString("utf-8");
          const referer = ref ? Buffer.from(ref, "base64").toString("utf-8") : undefined;

          // 1. SAFETY CHECK: If the requested URL is actually a .ts segment, 
          // redirect to the stream proxy immediately.
          // This prevents trying to parse binary video data as a text playlist.
          // 1. SAFETY CHECK: If the requested URL is actually a video file, 
          // redirect to the stream proxy immediately.
          // This prevents trying to parse binary video data as a text playlist.
          if (decodedUrl.match(/\.(ts|mp4|mkv|webm)($|\?)/i)) {
            const streamUrl = `/api/proxy/stream?url=${url}` + (ref ? `&ref=${ref}` : "");
            return h.redirect(streamUrl);
          }

          const playlistUrl = assertHttpUrl(decodedUrl).href;

          const headers: Record<string, string> = {};
          if (referer) headers["Referer"] = referer;

          // Fetch the text content of the M3U8
          const resp = await axios.get<string>(playlistUrl, {
            responseType: "text",
            headers,
            validateStatus: () => true,
          });

          if (resp.status < 200 || resp.status >= 300) return h.response({ error: "Fetch failed" }).code(resp.status);

          const body = resp.data || "";

          // Check if it's actually a playlist
          if (!body.startsWith("#EXTM3U")) {
            // If it's not a playlist, just pass it through as a stream
            const streamUrl = `/api/proxy/stream?url=${url}` + (ref ? `&ref=${ref}` : "");
            return h.redirect(streamUrl);
          }

          // Regex to find URI attributes or lines that look like URLs
          const urlRegex = /(URI="([^"]+)")|((^[^#\n\r].*)$)/gm;

          const rewritten = body.replace(
            urlRegex,
            (match, uriAttribute, uriValue, segmentUrl) => {
              const urlToRewrite = uriValue || segmentUrl;
              if (!urlToRewrite) return match;

              // Resolve relative URLs to absolute
              const absolute = new URL(urlToRewrite, playlistUrl).href;

              const b64url = Buffer.from(absolute).toString("base64");
              const b64ref = referer ? Buffer.from(referer).toString("base64") : undefined;

              let proxiedUrl: string;

              // 2. LOGIC: Decide where to route the internal URLs
              const isPlaylist = urlToRewrite.match(/\.m3u8($|\?)/i);
              const isSegment = urlToRewrite.match(/\.ts($|\?)/i);

              if (isPlaylist) {
                // Keep playlists in this route (/api/proxy)
                proxiedUrl = `/api/proxy?url=${b64url}` + (b64ref ? `&ref=${b64ref}` : "");
              } else if (isSegment) {
                // Pass .ts segments through the Stream Proxy
                proxiedUrl = getProxiedUrl(absolute, referer);
              } else {
                // Pass everything else (keys, subtitles, init maps) through the Stream Proxy as well
                proxiedUrl = getProxiedUrl(absolute, referer);
              }

              if (uriValue) return `URI="${proxiedUrl}"`;
              return proxiedUrl;
            }
          );

          return h.response(rewritten).type("application/vnd.apple.mpegurl").header("Cache-Control", "no-cache");
        } catch (err: any) {
          console.error("[/proxy] error:", err?.message || err);
          return h.response({ error: "Proxy failed" }).code(500);
        }
      },
    },
    // A. Serve the Frontend (from public) - Catch-all must be last
    {
      method: "GET",
      path: "/{param*}",
      handler: {
        directory: {
          path: path.join(__dirname, 'public'),
          redirectToSlash: true,
          index: true,
        },
      },
    },
  ]);

  // ==== 4. WebSocket Server (Multi-User Audio & Sync) ====

  const wssSignaling = new WebSocketServer({ noServer: true });
  // 2. Voice Server (Audio Data) - Binary Only
  const wssVoice = new WebSocketServer({ noServer: true });

  // Store connected users: userId -> { ws, nick, isAdmin }
  const clients = new Map<number, { ws: WebSocket; nick: string; isAdmin: boolean; isMuted: boolean }>();

  server.listener.on('upgrade', (request: IncomingMessage, socket: internal.Duplex, head: Buffer) => {
    const { url } = request;

    if (url === '/sync') {
      wssSignaling.handleUpgrade(request, socket, head, (ws) => {
        wssSignaling.emit('connection', ws, request);
      });
    } else if (url === '/voice') {
      wssVoice.handleUpgrade(request, socket, head, (ws) => {
        wssVoice.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wssVoice.on("connection", (ws: WebSocket) => {
    // We expect the FIRST message to be the UserID (4 bytes) to identify who this stream belongs to
    // or we can rely on the client sending ID in every packet (current implementation does this).

    ws.on("message", (data: any, isBinary: boolean) => {
      if (!isBinary) return; // Ignore non-binary on voice channel

      // Broadcast audio to all other voice clients immediately
      wssVoice.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          // In your current implementation, the client sends [UserID + PCM].
          // We just forward it raw. fast.
          client.send(data, { binary: true });
        }
      });
    });
  });

  wssSignaling.on("connection", (ws: WebSocket) => {
    // Assign a random 32-bit integer as User ID for this session
    const userId = Math.floor(Math.random() * 0xFFFFFFFF);
    clients.set(userId, { ws, nick: `User ${userId}`, isAdmin: false, isMuted: false });

    ws.send(JSON.stringify({ type: 'welcome', userId: userId }));

    const broadcastSystemState = () => {
      const stateMsg = JSON.stringify({
        type: 'system-state',
        userControlsAllowed: areUserControlsAllowed
      });
      wssSignaling.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(stateMsg));
    };
    // Helper to broadcast user list to admins
    const broadcastUserList = () => {
      const userList = Array.from(clients.entries()).map(([id, client]) => ({
        id,
        nick: client.nick,
        isAdmin: client.isAdmin,
        isMuted: client.isMuted
      }));

      // CHANGE: Send to ALL connected clients, not just admins
      wssSignaling.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'user-list', users: userList }));
        }
      });
    };

    ws.on("message", (data: any, isBinary: boolean) => {
      const sender = clients.get(userId);
      if (!sender) return;

      if (isBinary) return;

      // --- TEXT PACKET HANDLING ---
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'toggle-user-controls') {
          if (sender.isAdmin) {
            areUserControlsAllowed = !!msg.value;
            broadcastSystemState();

            // Notify via chat
            const chatMsg = JSON.stringify({
              type: 'chat', nick: 'System', isSystem: true,
              text: areUserControlsAllowed ? '🔓 User controls enabled' : '🔒 User controls disabled'
            });
            wssSignaling.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(chatMsg));
          }
          return;
        }
        if (msg.type === 'sync' || msg.type === 'forceSync') {
          if (sender.isAdmin || areUserControlsAllowed) {
            currentVideoState = {
              url: msg.url || currentVideoState.url,
              time: msg.time,
              paused: msg.paused,
              timestamp: Date.now()
            };
            // Broadcast to everyone
            wssSignaling.clients.forEach((client) => {
              if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(data, { binary: false });
              }
            });
          }
        }
        if (msg.type === 'timeUpdate') {
          if (sender.isAdmin || areUserControlsAllowed) {
            currentVideoState.time = msg.time;
            currentVideoState.timestamp = Date.now();
            currentVideoState.paused = msg.paused;
            // We do NOT broadcast this to avoid network spam. 
            // Clients sync via the initial join or manual events.
          }
        }

        // 3. Playback Sync (Admin OR Allowed Users)
        if (msg.type === 'load' && sender.isAdmin) {
          currentVideoState.url = msg.url;
          currentVideoState.time = 0;
          currentVideoState.paused = false; // Auto-play on load
          currentVideoState.timestamp = Date.now();
        }
        if (msg.type === 'mute-user' && sender.isAdmin) {
          const target = clients.get(msg.targetId);
          if (target) {
            target.isMuted = !target.isMuted; // Toggle
            broadcastUserList(); // Update UI
          }
        }

        if (msg.type === 'identify') {
          sender.nick = msg.nick || `User ${userId}`;
          broadcastUserList();
          ws.send(JSON.stringify({ type: 'system-state', userControlsAllowed: areUserControlsAllowed }));
          const joinMsg = JSON.stringify({
            type: 'chat',
            nick: 'System',
            text: `${sender.nick} joined the session`,
            isSystem: true
          });

          wssSignaling.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(joinMsg);
            }
          });
          if (currentVideoState.url) {
            // Calculate estimated current time
            let estimatedTime = currentVideoState.time;
            if (!currentVideoState.paused) {
              const elapsed = (Date.now() - currentVideoState.timestamp) / 1000;
              estimatedTime += elapsed;
            }

            ws.send(JSON.stringify({
              type: 'forceSync', // Force them to jump
              url: currentVideoState.url,
              time: estimatedTime,
              paused: currentVideoState.paused
            }));
          }
        } else if (msg.type === 'admin-login') {
          if (msg.password === 'admin123') { // Replace with real auth check
            sender.isAdmin = true;
            ws.send(JSON.stringify({ type: 'admin-success' }));
            broadcastUserList();
            ws.send(JSON.stringify({ type: 'system-state', userControlsAllowed: areUserControlsAllowed }));

          } else {
            ws.send(JSON.stringify({ type: 'admin-fail' }));
          }
        } else if (msg.type === 'kick-user') {
          if (sender.isAdmin) {
            const targetId = msg.targetId;
            const target = clients.get(targetId);
            if (target && target.ws.readyState === WebSocket.OPEN) {
              target.ws.close();
              clients.delete(targetId);
              broadcastUserList();
            }
          }
        } else {
          // Broadcast other messages (chat, sync, etc.)
          wssSignaling.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(data, { binary: false });
            }
          });
        }
      } catch (e) {
        console.error("WS Message Error", e);
      }

    });

    ws.on("close", () => {
      const nick = clients.get(userId)?.nick;
      clients.delete(userId);
      broadcastUserList();
      if (nick) {
        const leaveMsg = JSON.stringify({
          type: 'chat',
          nick: 'System',
          text: `${nick} left`,
          isSystem: true
        });
        wssSignaling.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(leaveMsg));
      }
    });
  });

  await server.start();
  console.log("🚀 SyncStream running on %s", server.info.uri);
  console.log("📂 Drop videos in: %s/downloads/", process.cwd());
};

process.on("unhandledRejection", (err) => {
  console.log(err);
  process.exit(1);
});

init();