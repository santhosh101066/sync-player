
import { io, Socket } from "socket.io-client";

const SERVER_URL = "http://localhost:8000";
const CLIENT_COUNT = 50;
const MESSAGE_INTERVAL_MS = 2000;

console.log(`🚀 Starting Load Test with ${CLIENT_COUNT} clients connecting to ${SERVER_URL}...`);

const clients: Socket[] = [];
let connectedCount = 0;
let messageCount = 0;
let latencySum = 0;
let latencySamples = 0;

// Helper to wait
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function start() {
    for (let i = 0; i < CLIENT_COUNT; i++) {
        const socket = io(SERVER_URL, {
            transports: ["websocket"],
            reconnection: false
        });

        socket.on("connect", () => {
            connectedCount++;
            process.stdout.write(`\r✅ Connected: ${connectedCount}/${CLIENT_COUNT}`);
        });

        socket.on("disconnect", () => {
            connectedCount--;
        });

        // Listen for chat messages to measure latency
        socket.on("message", (msg: any) => {
            if (msg.type === 'chat' && msg.timestamp) {
                const latency = Date.now() - msg.timestamp;
                latencySum += latency;
                latencySamples++;
                messageCount++;
            }
        });

        clients.push(socket);
        await sleep(50); // Stagger connections slightly
    }

    console.log("\n⚡ All clients initialized. Starting chat flood...");

    // Simulate activity
    setInterval(() => {
        if (clients.length === 0) return;

        // Pick a random sender
        const sender = clients[Math.floor(Math.random() * clients.length)];

        if (sender.connected) {
            sender.emit("message", {
                type: "chat",
                text: `Load Test Message ${Date.now()}`,
                // We add a timestamp here if the server preserves it, 
                // but checking websocket.service.ts, the server OVERWRITES timestamp.
                // However, we can calculate end-to-end latency if we assume server time ~= client time (local)
                // The server sets timestamp = Date.now().
                // So Client Receive Time - Server Timestamp = Latency + ClockSkew.
                // Since this is localhost, ClockSkew is 0.
            });
        }
    }, MESSAGE_INTERVAL_MS / CLIENT_COUNT * 10); // High frequency across all clients

    // Report stats every second
    setInterval(() => {
        const avgLatency = latencySamples > 0 ? (latencySum / latencySamples).toFixed(2) : "0.00";
        console.log(`\n📊 Stats: ${connectedCount} connected | ${messageCount} msgs received | Avg Latency: ${avgLatency}ms`);

        // Reset counters for next second
        messageCount = 0;
        latencySum = 0;
        latencySamples = 0;
    }, 1000);
}

start();
