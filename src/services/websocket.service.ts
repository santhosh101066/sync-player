import { Server, IncomingMessage } from "http";
import internal from "stream";
import { WebSocketServer, WebSocket } from "ws";
import { serverState } from "./state.service";

interface Client {
    ws: WebSocket;
    nick: string;
    isAdmin: boolean;
    isMuted: boolean;
}

export class WebSocketService {
    private wssSignaling: WebSocketServer;
    private wssVoice: WebSocketServer;
    private clients = new Map<number, Client>();

    constructor() {
        this.wssSignaling = new WebSocketServer({ noServer: true });
        this.wssVoice = new WebSocketServer({ noServer: true });
        this.setupSignaling();
        this.setupVoice();
    }

    public handleUpgrade(request: IncomingMessage, socket: internal.Duplex, head: Buffer) {
        const { url } = request;
        if (url === '/sync') {
            this.wssSignaling.handleUpgrade(request, socket, head, (ws) => {
                this.wssSignaling.emit('connection', ws, request);
            });
        } else if (url === '/voice') {
            this.wssVoice.handleUpgrade(request, socket, head, (ws) => {
                this.wssVoice.emit('connection', ws, request);
            });
        } else {
            socket.destroy();
        }
    }

    private broadcastSystemState() {
        const stateMsg = JSON.stringify({
            type: 'system-state',
            userControlsAllowed: serverState.areUserControlsAllowed,
            proxyEnabled: serverState.isProxyEnabled
        });
        this.wssSignaling.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(stateMsg));
    }

    private broadcastUserList() {
        const userList = Array.from(this.clients.entries()).map(([id, client]) => ({
            id,
            nick: client.nick,
            isAdmin: client.isAdmin,
            isMuted: client.isMuted
        }));

        this.wssSignaling.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'user-list', users: userList }));
            }
        });
    }

    private broadcastChat(nick: string, text: string, isSystem = false) {
        const msg = JSON.stringify({
            type: 'chat',
            nick,
            text,
            isSystem
        });
        this.wssSignaling.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(msg));
    }

    private setupVoice() {
        this.wssVoice.on("connection", (ws: WebSocket) => {
            ws.on("message", (data: any, isBinary: boolean) => {
                if (!isBinary) return;

                // Broadcast voice data to all other clients
                this.wssVoice.clients.forEach((client) => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(data, { binary: true });
                    }
                });
            });
        });
    }

    private setupSignaling() {
        this.wssSignaling.on("connection", (ws: WebSocket) => {
            const userId = Math.floor(Math.random() * 0xFFFFFFFF);
            this.clients.set(userId, { ws, nick: `User ${userId}`, isAdmin: false, isMuted: false });

            ws.send(JSON.stringify({ type: 'welcome', userId: userId }));

            ws.on("message", (data: any, isBinary: boolean) => {
                const sender = this.clients.get(userId);
                if (!sender) return;
                if (isBinary) return;

                try {
                    const msg = JSON.parse(data.toString());

                    // --- ADMIN CONTROLS ---
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

                    // --- SYNC ---
                    if (msg.type === 'sync' || msg.type === 'forceSync') {
                        if (sender.isAdmin || serverState.areUserControlsAllowed) {
                            serverState.currentVideoState = {
                                url: msg.url || serverState.currentVideoState.url,
                                time: msg.time,
                                paused: msg.paused,
                                timestamp: Date.now()
                            };
                            // Broadcast to others
                            this.wssSignaling.clients.forEach((client) => {
                                if (client !== ws && client.readyState === WebSocket.OPEN) {
                                    client.send(data, { binary: false });
                                }
                            });
                        }
                    }

                    // --- LOAD ---
                    if (msg.type === 'load' && sender.isAdmin) {
                        serverState.currentVideoState = {
                            url: msg.url,
                            time: 0,
                            paused: false,
                            timestamp: Date.now()
                        };
                    }

                    // --- USER MANAGEMENT ---
                    if (msg.type === 'get-users' && sender.isAdmin) {
                        // Send just to the requester
                        const userList = Array.from(this.clients.entries()).map(([id, client]) => ({
                            id,
                            nick: client.nick,
                            isAdmin: client.isAdmin,
                            isMuted: client.isMuted
                        }));
                        ws.send(JSON.stringify({ type: 'user-list', users: userList }));
                    }

                    if (msg.type === 'mute-user' && sender.isAdmin) {
                        const target = this.clients.get(msg.targetId);
                        if (target) {
                            target.isMuted = !target.isMuted;
                            this.broadcastUserList();
                        }
                    }

                    if (msg.type === 'kick-user' && sender.isAdmin) {
                        const target = this.clients.get(msg.targetId);
                        if (target && target.ws.readyState === WebSocket.OPEN) {
                            target.ws.close();
                            this.clients.delete(msg.targetId);
                            this.broadcastUserList();
                        }
                    }

                    if (msg.type === 'identify') {
                        sender.nick = msg.nick || `User ${userId}`;
                        this.broadcastUserList();
                        ws.send(JSON.stringify({
                            type: 'system-state',
                            userControlsAllowed: serverState.areUserControlsAllowed,
                            proxyEnabled: serverState.isProxyEnabled
                        }));
                        this.broadcastChat('System', `${sender.nick} joined the session`, true);

                        if (serverState.currentVideoState.url) {
                            let estimatedTime = serverState.currentVideoState.time;
                            if (!serverState.currentVideoState.paused) {
                                const elapsed = (Date.now() - serverState.currentVideoState.timestamp) / 1000;
                                estimatedTime += elapsed;
                            }
                            ws.send(JSON.stringify({
                                type: 'forceSync',
                                url: serverState.currentVideoState.url,
                                time: estimatedTime,
                                paused: serverState.currentVideoState.paused
                            }));
                        }
                    } else if (msg.type === 'admin-login') {
                        if (msg.password === 'admin123') {
                            sender.isAdmin = true;
                            ws.send(JSON.stringify({ type: 'admin-success' }));
                            this.broadcastUserList();
                            ws.send(JSON.stringify({
                                type: 'system-state',
                                userControlsAllowed: serverState.areUserControlsAllowed,
                                proxyEnabled: serverState.isProxyEnabled
                            }));
                        } else {
                            ws.send(JSON.stringify({ type: 'admin-fail' }));
                        }
                    } else {
                        // Broadcast everything else (chat, etc)
                        this.wssSignaling.clients.forEach((client) => {
                            if (client !== ws && client.readyState === WebSocket.OPEN) {
                                client.send(data, { binary: false });
                            }
                        });
                    }

                } catch (e) {
                    console.error("WS Error", e);
                }
            });

            ws.on("close", () => {
                const nick = this.clients.get(userId)?.nick;
                this.clients.delete(userId);
                this.broadcastUserList();
                if (nick) this.broadcastChat('System', `${nick} left`, true);
            });
        });
    }
}
