import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { serverState } from "./state.service";

// Define the Client interface
interface Client {
    socket: Socket;
    nick: string;
    isAdmin: boolean;
    isMuted: boolean;
    userId: number; 
}

// Define structure for stored messages
interface StoredChatMessage {
    type: 'chat';
    nick: string;
    text: string;
    isAdmin: boolean;
    isSystem: boolean;
    timestamp: number;
}

export class WebSocketService {
    private io: Server | undefined;
    private clients = new Map<string, Client>();
    
    // 1. CHAT HISTORY STORAGE
    private chatHistory: StoredChatMessage[] = [];
    private readonly MAX_HISTORY = 50; // Keep last 50 messages

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
                userId
            };
            this.clients.set(socket.id, client);

            console.log(`[Connect] ${client.nick} (${socket.id})`);

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
                    console.error("Message Processing Error:", e);
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

    private handleMessage(socket: Socket, msg: any) {
        const sender = this.clients.get(socket.id);
        if (!sender) return;

        if (msg.type === 'identify') {
            sender.nick = msg.nick || `User ${sender.userId}`;
            this.broadcastUserList();
            
            // We do NOT save "User joined" to history
            socket.broadcast.emit("message", {
                type: 'chat',
                nick: 'System',
                text: `${sender.nick} joined the session`,
                isSystem: true
            });
            return;
        }

        if (msg.type === 'admin-login') {
            if (msg.password === 'admin123') { 
                sender.isAdmin = true;
                socket.emit("message", { type: 'admin-success' });
                this.broadcastUserList();
                socket.emit("message", {
                    type: 'system-state',
                    userControlsAllowed: serverState.areUserControlsAllowed,
                    proxyEnabled: serverState.isProxyEnabled
                });
            } else {
                socket.emit("message", { type: 'admin-fail' });
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
                timestamp: Date.now()
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
            this.broadcastSystemState();
            this.broadcastChat('System', serverState.areUserControlsAllowed ? '🔓 User controls enabled' : '🔒 User controls disabled', true);
            return;
        }

        if (msg.type === 'toggle-proxy' && sender.isAdmin) {
            serverState.isProxyEnabled = !!msg.value;
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
                socket.broadcast.emit("message", msg);
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
                paused: false, 
                timestamp: Date.now()
            };
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
            isMuted: c.isMuted
        }));
        this.io?.emit("message", { type: 'user-list', users: userList });
    }

    private sendUserListTo(socket: Socket) {
        const userList = Array.from(this.clients.values()).map(c => ({
            id: c.userId,
            nick: c.nick,
            isAdmin: c.isAdmin,
            isMuted: c.isMuted
        }));
        socket.emit("message", { type: 'user-list', users: userList });
    }

    private broadcastChat(nick: string, text: string, isSystem = false) {
        const msg: StoredChatMessage = {
            type: 'chat',
            nick,
            text,
            isSystem,
            isAdmin: false,
            timestamp: Date.now()
        };
        
        // Save System announcements to history
        this.chatHistory.push(msg);
        if (this.chatHistory.length > this.MAX_HISTORY) this.chatHistory.shift();

        this.io?.emit("message", msg);
    }
}