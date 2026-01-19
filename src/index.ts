import "dotenv/config";
import Hapi from "@hapi/hapi";
import Inert from "@hapi/inert";
import path from "path";
import { WebSocketService } from "./services/websocket.service";
import { logger } from "./services/logger.service";
import { routes } from "./routes";

const init = async () => {
    const server = Hapi.server({
        port: 8000,
        host: "0.0.0.0",
        routes: {
            cors: {
                origin: ["http://localhost:5173", "http://localhost:8000"],
                additionalHeaders: ["cache-control", "x-requested-with"]
            },
            files: {
                relativeTo: process.cwd()
            },
            state: {
                parse: true,
                failAction: 'ignore'
            }
        },
    });

    await server.register(Inert);
    server.route(routes);

    // SPA Fallback: Serve index.html for 404s on non-API routes
    server.ext('onPreResponse', (request, h) => {
        const response = request.response;
        if ((response as any).isBoom && (response as any).output.statusCode === 404 && request.method === 'get' && !request.path.startsWith('/api')) {
            return h.file(path.join(process.cwd(), 'public', 'index.html'));
        }
        return h.continue;
    });

    // Initialize WebSocket Service which attaches to the server listener
    const wsService = new WebSocketService();

    // We need to access the underlying node http server to handle upgrades
    if (server.listener) {
        wsService.attach(server.listener);
    }

    await server.start();
    logger.info(`🚀 SyncStream running on ${server.info.uri}`);
    logger.info(`📂 Drop videos in: ${process.cwd()}/downloads/`);
};

process.on("unhandledRejection", (err) => {
    logger.error(err);
    process.exit(1);
});

init();
