import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { OAuth2Client } from 'google-auth-library';
import { persistState, serverState } from "./state.service";
import { logger } from "./logger.service";
import { hashGoogleId } from "../utils/crypto.utils";
import axios from "axios";
import fs from "fs";
import path from "path";


const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ""; // [UPDATE THIS]

if (!GOOGLE_CLIENT_ID) {
    logger.warn("⚠️ WARNING: GOOGLE_CLIENT_ID is missing in .env file!");
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Define the Client interface
interface Client {
    socket: Socket;
    nick: string;
    isAdmin: boolean;
    isMuted: boolean;
    userId: string;  // Changed from number to string (hashed Google ID)
    googleId?: string;  // Store original Google ID for reference
    picture?: string;
    isAuthenticated: boolean;
    isReady: boolean;
}

// Define structure for stored messages
interface StoredChatMessage {
    type: 'chat';
    nick: string;
    text: string;
    isAdmin: boolean;
    isSystem: boolean;
    timestamp: number;
    picture?: string;
    image?: string;
}

export class WebSocketService {
    private io: Server | undefined;
    private clients = new Map<string, Client>();

    // 1. CHAT HISTORY STORAGE
    private chatHistory: StoredChatMessage[] = [];
    private readonly MAX_HISTORY = 50; // Keep last 50 messages

    private async cacheProfileImage(url: string, userId: string): Promise<string> {
        try {
            const uploadDir = path.join(process.cwd(), 'uploads');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }

            const filename = `profile-${userId}.jpg`;
            const filePath = path.join(uploadDir, filename);
            const publicUrl = `/uploads/${filename}`;

            // Check if already cached (optional: could check age)
            if (fs.existsSync(filePath)) {
                return publicUrl;
            }

            const response = await axios({
                url,
                method: 'GET',
                responseType: 'stream'
            });

            const writer = fs.createWriteStream(filePath);
            response.data.pipe(writer);

            return new Promise((resolve, reject) => {
                writer.on('finish', () => resolve(publicUrl));
                writer.on('error', reject);
            });
        } catch (error) {
            logger.error(`Failed to cache profile image: ${error}`);
            return url; // Fallback to original URL
        }
    }

    public attach(httpServer: HttpServer) {
        this.io = new Server(httpServer, {
            cors: { origin: "*", methods: ["GET", "POST"] },
            transports: ['polling', 'websocket'],
            maxHttpBufferSize: 1e6,
            pingInterval: 10000, // Send a ping every 10 seconds
            pingTimeout: 5000    // Wait 5 seconds for a pong
        });

        this.setupSocketIO();
    }

    private setupSocketIO() {
        if (!this.io) return;

        this.io.on("connection", (socket: Socket) => {
            // Generate temporary ID until Google auth completes
            const tempUserId = `temp_${socket.id}`;

            const client: Client = {
                socket,
                nick: "Authenticating...",
                isAdmin: false,
                isMuted: false,
                userId: tempUserId,
                isAuthenticated: false,
                isReady: false
            };
            this.clients.set(socket.id, client);

            logger.info(`[Connect] ${client.nick} (${socket.id})`);

            socket.emit("message", { type: 'welcome', userId: tempUserId });

            socket.emit("message", {
                type: 'system-state',
                userControlsAllowed: serverState.areUserControlsAllowed,
                proxyEnabled: serverState.isProxyEnabled
            });

            // 2. SEND HISTORY ON CONNECT
            if (this.chatHistory.length > 0) {
                socket.emit("message", {
                    type: 'chat-history',
                    messages: this.chatHistory
                });
            }

            if (serverState.currentVideoState.url) {
                let estimatedTime = serverState.currentVideoState.time;
                if (!serverState.currentVideoState.paused) {
                    const elapsed = (Date.now() - serverState.currentVideoState.timestamp) / 1000;
                    estimatedTime += elapsed;
                }
                socket.emit("message", {
                    type: 'forceSync',
                    url: serverState.currentVideoState.url,
                    time: estimatedTime,
                    paused: serverState.currentVideoState.paused
                });
            }

            // Send queue state to new client
            this.sendQueueStateTo(socket);

            socket.on("voice", (data: any) => {
                const sender = this.clients.get(socket.id);
                if (!sender || sender.isMuted) return;
                socket.broadcast.emit("voice", data);
            });

            socket.on("message", (msg: any) => {
                try {
                    this.handleMessage(socket, msg);
                } catch (e) {
                    logger.error(`Message Processing Error: ${e}`);
                }
            });

            socket.on("disconnect", () => {
                const leaver = this.clients.get(socket.id);
                if (leaver) {
                    this.clients.delete(socket.id);
                    this.broadcastUserList();
                    // We do NOT save "User left" to history to keep it clean for new joiners
                    this.io?.emit("message", {
                        type: 'chat',
                        nick: 'System',
                        text: `${leaver.nick} left`,
                        isSystem: true
                    });
                }
            });
        });
    }

    private async handleMessage(socket: Socket, msg: any) {
        const sender = this.clients.get(socket.id);
        if (!sender) return;

        if (msg.type === 'auth-google') {
            try {
                const ticket = await googleClient.verifyIdToken({
                    idToken: msg.token,
                    audience: GOOGLE_CLIENT_ID,
                });
                const payload = ticket.getPayload();

                if (payload) {
                    logger.info(`[Auth] Payload: name='${payload.name}', given='${payload.given_name}', mail='${payload.email}', pic='${!!payload.picture}'`);

                    // Generate unique userId from Google ID
                    const hashedUserId = hashGoogleId(payload.sub);

                    // DEDUPLICATION: Check for existing connections with same Google ID
                    let existingClient: Client | undefined;
                    for (const [socketId, client] of this.clients) {
                        if (client.userId === hashedUserId && socketId !== socket.id) {
                            existingClient = client;
                            logger.info(`[Dedup] Found existing session for ${payload.name} (${socketId})`);
                            break;
                        }
                    }

                    // If user already connected, disconnect old socket
                    if (existingClient) {
                        logger.info(`[Dedup] Disconnecting old session for ${payload.name}`);
                        existingClient.socket.emit("message", {
                            type: 'session-replaced',
                            text: 'You have been logged in from another device/tab'
                        });
                        existingClient.socket.disconnect(true);
                        this.clients.delete(existingClient.socket.id);
                    }

                    // Update current client with hashed ID
                    sender.userId = hashedUserId;
                    sender.googleId = payload.sub;
                    sender.isAuthenticated = true;

                    // Fix: Use name -> given_name -> email part
                    sender.nick = payload.name || payload.given_name || payload.email?.split('@')[0] || "Google User";

                    if (payload.picture) {
                        sender.picture = await this.cacheProfileImage(payload.picture, payload.sub);
                    } else {
                        sender.picture = undefined;
                    }

                    // Optional: Auto-make specific emails Admin
                    const adminEmail = process.env.ADMIN_EMAIL;
                    if (adminEmail && payload.email === adminEmail) {
                        sender.isAdmin = true;
                        socket.emit("message", { type: 'admin-success' });
                    }

                    logger.info(`[Auth] Verified: ${sender.nick} (userId: ${hashedUserId.substring(0, 8)}...)`);
                    this.broadcastUserList();

                    // Send welcome/state just like 'identify'
                    socket.emit("message", {
                        type: 'auth-success',
                        nick: sender.nick,
                        picture: sender.picture,
                        email: payload.email,
                        userId: sender.userId // Send the new hashed ID
                    });

                    socket.emit("message", {
                        type: 'system-state',
                        userControlsAllowed: serverState.areUserControlsAllowed,
                        proxyEnabled: serverState.isProxyEnabled
                    });

                    // Notify others
                    socket.broadcast.emit("message", {
                        type: 'chat',
                        nick: 'System',
                        text: `${sender.nick} logged in with Google`,
                        isSystem: true
                    });

                    // 4. Send Video Sync (Force Sync) - MATCHING IDENTIFY LOGIC
                    if (serverState.currentVideoState.url) {
                        let estimatedTime = serverState.currentVideoState.time;
                        if (!serverState.currentVideoState.paused) {
                            const elapsed = (Date.now() - serverState.currentVideoState.timestamp) / 1000;
                            estimatedTime += elapsed;
                        }

                        logger.info(`[Auth] Sending forceSync at ${estimatedTime.toFixed(1)}s`);

                        socket.emit("message", {
                            type: 'forceSync',
                            url: serverState.currentVideoState.url,
                            time: estimatedTime,
                            paused: serverState.currentVideoState.paused
                        });
                    }
                }
            } catch (error) {
                logger.error(`Google Auth Failed: ${error}`);
                socket.emit("message", { type: 'error', text: "Authentication failed" });
            }
            return;
        }

        if (msg.type === 'auth-dev') {
            const devEmail = msg.email;
            const adminEmail = process.env.ADMIN_EMAIL;

            if (adminEmail && devEmail === adminEmail) {
                const hashedUserId = hashGoogleId(devEmail); // Use email as ID source for consistent dev ID

                // DEDUPLICATION: Check for existing connections
                let existingClient: Client | undefined;
                for (const [socketId, client] of this.clients) {
                    if (client.userId === hashedUserId && socketId !== socket.id) {
                        existingClient = client;
                        break;
                    }
                }

                if (existingClient) {
                    existingClient.socket.emit("message", {
                        type: 'session-replaced',
                        text: 'Dev session replaced'
                    });
                    existingClient.socket.disconnect(true);
                    this.clients.delete(existingClient.socket.id);
                }

                sender.userId = hashedUserId;
                sender.googleId = devEmail;
                sender.isAuthenticated = true;
                sender.nick = "Dev Admin";
                sender.isAdmin = true; // Always admin for dev auth with correct email
                sender.picture = undefined;

                logger.info(`[Auth-Dev] Verified: ${sender.nick} (${devEmail})`);
                this.broadcastUserList();

                socket.emit("message", {
                    type: 'auth-success',
                    nick: sender.nick,
                    email: devEmail,
                    userId: sender.userId // Send the new hashed ID
                });

                socket.emit("message", { type: 'admin-success' });

                socket.emit("message", {
                    type: 'system-state',
                    userControlsAllowed: serverState.areUserControlsAllowed,
                    proxyEnabled: serverState.isProxyEnabled
                });

                socket.broadcast.emit("message", {
                    type: 'chat',
                    nick: 'System',
                    text: `${sender.nick} logged in via Dev Auth`,
                    isSystem: true
                });

                // Send Sync
                if (serverState.currentVideoState.url) {
                    let estimatedTime = serverState.currentVideoState.time;
                    if (!serverState.currentVideoState.paused) {
                        const elapsed = (Date.now() - serverState.currentVideoState.timestamp) / 1000;
                        estimatedTime += elapsed;
                    }
                    socket.emit("message", {
                        type: 'forceSync',
                        url: serverState.currentVideoState.url,
                        time: estimatedTime,
                        paused: serverState.currentVideoState.paused
                    });
                }
            } else {
                socket.emit("message", { type: 'error', text: "Dev Authentication failed" });
            }
            return;
        }


        // --- CHAT HANDLING ---
        if (msg.type === 'chat') {
            const chatMsg: StoredChatMessage = {
                type: 'chat',
                nick: sender.nick,
                text: msg.text,
                isAdmin: sender.isAdmin,
                isSystem: false,
                timestamp: Date.now(),
                picture: sender.picture,
                image: msg.image
            };

            // 3. STORE MESSAGE IN MEMORY
            this.chatHistory.push(chatMsg);
            if (this.chatHistory.length > this.MAX_HISTORY) {
                this.chatHistory.shift(); // Remove oldest
            }

            // Broadcast to others (Sender handles display locally)
            socket.broadcast.emit("message", chatMsg);
            return;
        }

        if (msg.type === 'toggle-user-controls' && sender.isAdmin) {
            serverState.areUserControlsAllowed = !!msg.value;
            persistState(); // <--- SAVE
            this.broadcastSystemState();
            this.broadcastChat('System', serverState.areUserControlsAllowed ? '🔓 User controls enabled' : '🔒 User controls disabled', true);
            return;
        }

        if (msg.type === 'toggle-proxy' && sender.isAdmin) {
            serverState.isProxyEnabled = !!msg.value;
            persistState(); // <--- SAVE
            this.broadcastSystemState();
            this.broadcastChat('System', serverState.isProxyEnabled ? '📡 Proxy Mode ENABLED' : '🔌 Proxy Mode DISABLED', true);
            return;
        }

        if (msg.type === 'get-users' && sender.isAdmin) {
            this.sendUserListTo(socket);
            return;
        }

        if (msg.type === 'mute-user' && sender.isAdmin) {
            for (const [_, client] of this.clients) {
                if (client.userId === msg.targetId) {
                    client.isMuted = !client.isMuted;
                    this.broadcastUserList();
                    break;
                }
            }
            return;
        }

        if (msg.type === 'kick-user' && sender.isAdmin) {
            for (const [_, client] of this.clients) {
                if (client.userId === msg.targetId) {
                    client.socket.emit("message", { type: 'kick' });
                    setTimeout(() => client.socket.disconnect(true), 100);
                    break;
                }
            }
            return;
        }

        if (msg.type === 'sync' || msg.type === 'forceSync') {
            if (sender.isAdmin || serverState.areUserControlsAllowed) {
                serverState.currentVideoState = {
                    url: msg.url || serverState.currentVideoState.url,
                    time: msg.time,
                    paused: msg.paused,
                    timestamp: Date.now()
                };
                persistState();
                socket.broadcast.emit("message", msg);
            } else {
                logger.warn(`[Sync] Ignored sync from ${sender.nick} (Admin: ${sender.isAdmin}, Controls: ${serverState.areUserControlsAllowed})`);
            }
            return;
        }

        if (msg.type === 'timeUpdate') {
            if (sender.isAdmin || serverState.areUserControlsAllowed) {
                serverState.currentVideoState.time = msg.time;
                serverState.currentVideoState.timestamp = Date.now();
                serverState.currentVideoState.paused = msg.paused;
            }
            return;
        }

        if (msg.type === 'ready') {
            sender.isReady = !!msg.value;
            this.broadcastUserList();
            return;
        }

        if (msg.type === 'load' && sender.isAdmin) {
            // Reset everyone's ready state
            for (const client of this.clients.values()) {
                client.isReady = false;
            }
            this.broadcastUserList();

            serverState.currentVideoState = {
                url: msg.url,
                time: 0,
                paused: true,
                timestamp: Date.now()
            };
            persistState();
            this.io?.emit("message", { type: 'load', url: msg.url });
            return;
        }

        // --- QUEUE MANAGEMENT HANDLERS ---

        if (msg.type === 'queue-add') {
            // All users can add to queue
            const queueItem = {
                id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                videoId: msg.video.videoId,
                url: msg.video.url,
                title: msg.video.title,
                thumbnail: msg.video.thumbnail,
                author: msg.video.author,
                duration: msg.video.duration,
                addedBy: sender.userId,
                addedAt: Date.now()
            };
            serverState.videoQueue.push(queueItem);
            persistState();
            this.broadcastQueueState();
            logger.info(`[Queue] ${sender.nick} added: ${queueItem.title}`);
            return;
        }

        if (msg.type === 'queue-play-next' && sender.isAdmin) {
            // Insert at front of queue
            const queueItem = {
                id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                videoId: msg.video.videoId,
                url: msg.video.url,
                title: msg.video.title,
                thumbnail: msg.video.thumbnail,
                author: msg.video.author,
                duration: msg.video.duration,
                addedBy: sender.userId,
                addedAt: Date.now()
            };
            serverState.videoQueue.unshift(queueItem);
            // Adjust current index if we're playing from queue
            if (serverState.currentQueueIndex >= 0) {
                serverState.currentQueueIndex++;
            }
            persistState();
            this.broadcastQueueState();
            logger.info(`[Queue] ${sender.nick} added to front: ${queueItem.title}`);
            return;
        }

        if (msg.type === 'queue-play-now' && sender.isAdmin) {
            // Play immediately, not from queue
            serverState.currentQueueIndex = -1;
            serverState.currentVideoState = {
                url: msg.video.url,
                time: 0,
                paused: false,
                timestamp: Date.now()
            };
            persistState();
            this.io?.emit("message", {
                type: 'load',
                url: msg.video.url
            });
            logger.info(`[Queue] ${sender.nick} playing now: ${msg.video.title}`);
            return;
        }

        if (msg.type === 'queue-remove' && sender.isAdmin) {
            const itemIndex = serverState.videoQueue.findIndex(item => item.id === msg.itemId);
            if (itemIndex !== -1) {
                const removed = serverState.videoQueue.splice(itemIndex, 1)[0];

                // Adjust current index if needed
                if (serverState.currentQueueIndex > itemIndex) {
                    serverState.currentQueueIndex--;
                } else if (serverState.currentQueueIndex === itemIndex) {
                    // Removed the currently playing video - keep playing but mark as not from queue
                    serverState.currentQueueIndex = -1;
                }

                persistState();
                this.broadcastQueueState();
                logger.info(`[Queue] ${sender.nick} removed: ${removed.title}`);
            }
            return;
        }

        if (msg.type === 'queue-reorder' && sender.isAdmin) {
            const { fromIndex, toIndex } = msg;
            if (fromIndex >= 0 && fromIndex < serverState.videoQueue.length &&
                toIndex >= 0 && toIndex < serverState.videoQueue.length) {

                const [item] = serverState.videoQueue.splice(fromIndex, 1);
                serverState.videoQueue.splice(toIndex, 0, item);

                // Adjust current index if needed
                if (serverState.currentQueueIndex === fromIndex) {
                    serverState.currentQueueIndex = toIndex;
                } else if (fromIndex < serverState.currentQueueIndex && toIndex >= serverState.currentQueueIndex) {
                    serverState.currentQueueIndex--;
                } else if (fromIndex > serverState.currentQueueIndex && toIndex <= serverState.currentQueueIndex) {
                    serverState.currentQueueIndex++;
                }

                persistState();
                this.broadcastQueueState();
                logger.info(`[Queue] ${sender.nick} reordered: ${fromIndex} -> ${toIndex}`);
            }
            return;
        }

        if (msg.type === 'queue-get') {
            this.sendQueueStateTo(socket);
            return;
        }

        if (msg.type === 'video-ended') {
            // Auto-advance logic: FIFO Queue
            // The currently playing video is always at index 0 (or we just treat the queue as a list to consume)

            if (serverState.videoQueue.length > 0) {
                // 1. Remove the video that just finished (the head of the queue)
                const finishedVideo = serverState.videoQueue.shift();
                logger.info(`[Queue] Finished & Removed: ${finishedVideo?.title}`);

                // 2. Check if there are more videos
                if (serverState.videoQueue.length > 0) {
                    const nextVideo = serverState.videoQueue[0];
                    serverState.currentQueueIndex = 0; // Always playing the head

                    serverState.currentVideoState = {
                        url: nextVideo.url,
                        time: 0,
                        paused: false,
                        timestamp: Date.now()
                    };
                    persistState();

                    // 3. Notify clients to load & play
                    this.io?.emit("message", {
                        type: 'load',
                        url: nextVideo.url
                    });
                    this.broadcastQueueState();
                    logger.info(`[Queue] Auto-playing next: ${nextVideo.title}`);
                } else {
                    // Queue is now empty
                    serverState.currentQueueIndex = -1;
                    persistState();
                    this.broadcastQueueState();
                    logger.info(`[Queue] Queue finished. All videos played.`);
                }
            }
            return;
        }

        if (msg.type === 'ping') {
            socket.emit("message", { type: 'pong', startTime: msg.startTime });
            return;
        }
    }

    private broadcastSystemState() {
        this.io?.emit("message", {
            type: 'system-state',
            userControlsAllowed: serverState.areUserControlsAllowed,
            proxyEnabled: serverState.isProxyEnabled
        });
    }

    private broadcastUserList() {
        const userList = Array.from(this.clients.values()).map(c => ({
            id: c.userId,
            nick: c.nick,
            isAdmin: c.isAdmin,
            isMuted: c.isMuted,
            isReady: c.isReady,
            picture: c.picture
        }));
        this.io?.emit("message", { type: 'user-list', users: userList });
    }

    private sendUserListTo(socket: Socket) {
        const userList = Array.from(this.clients.values()).map(c => ({
            id: c.userId,
            nick: c.nick,
            isAdmin: c.isAdmin,
            isMuted: c.isMuted,
            isReady: c.isReady,
            picture: c.picture
        }));
        socket.emit("message", { type: 'user-list', users: userList });
    }

    private broadcastChat(nick: string, text: string, isSystem = false, image?: string) {
        const msg: StoredChatMessage = {
            type: 'chat',
            nick,
            text,
            isSystem,
            isAdmin: false,
            timestamp: Date.now(),
            image
        };

        // Save System announcements to history
        this.chatHistory.push(msg);
        if (this.chatHistory.length > this.MAX_HISTORY) this.chatHistory.shift();

        this.io?.emit("message", msg);
    }

    private broadcastQueueState() {
        this.io?.emit("message", {
            type: 'queue-state',
            queue: serverState.videoQueue,
            currentIndex: serverState.currentQueueIndex
        });
    }

    private sendQueueStateTo(socket: Socket) {
        socket.emit("message", {
            type: 'queue-state',
            queue: serverState.videoQueue,
            currentIndex: serverState.currentQueueIndex
        });
    }
}