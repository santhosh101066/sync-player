import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { OAuth2Client } from 'google-auth-library';
import { persistState, serverState } from "./state.service";
import { logger } from "./logger.service";
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
    userId: number;
    picture?: string;
    isAuthenticated: boolean;
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
            maxHttpBufferSize: 1e6
        });

        this.setupSocketIO();
    }

    private setupSocketIO() {
        if (!this.io) return;

        this.io.on("connection", (socket: Socket) => {
            const userId = Math.floor(Math.random() * 0xFFFFFFFF);

            const client: Client = {
                socket,
                nick: `User ${userId}`,
                isAdmin: false,
                isMuted: false,
                userId,
                isAuthenticated: false
            };
            this.clients.set(socket.id, client);

            logger.info(`[Connect] ${client.nick} (${socket.id})`);

            socket.emit("message", { type: 'welcome', userId });

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

                    logger.info(`[Auth] Verified: ${sender.nick}`);
                    this.broadcastUserList();

                    // Send welcome/state just like 'identify'
                    socket.emit("message", {
                        type: 'auth-success',
                        nick: sender.nick,
                        picture: sender.picture
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

        if (msg.type === 'load' && sender.isAdmin) {
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
}