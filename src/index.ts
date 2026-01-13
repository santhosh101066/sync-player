import Hapi from "@hapi/hapi";
import Inert from "@hapi/inert";
import { WebSocketService } from "./services/websocket.service";
import { routes } from "./routes";

const init = async () => {
    const server = Hapi.server({
        port: 8000,
        host: "0.0.0.0",
        routes: {
            cors: {
                origin: ["*"],
                additionalHeaders: ["cache-control", "x-requested-with"]
            },
            files: {
                relativeTo: process.cwd()
            }
        },
    });

    await server.register(Inert);
    server.route(routes);

    // Initialize WebSocket Service which attaches to the server listener
    const wsService = new WebSocketService();

    // We need to access the underlying node http server to handle upgrades
    if (server.listener) {
        wsService.attach(server.listener);
    }

    await server.start();
    console.log("🚀 SyncStream running on %s", server.info.uri);
    console.log("📂 Drop videos in: %s/downloads/", process.cwd());
};

process.on("unhandledRejection", (err) => {
    console.log(err);
    process.exit(1);
});

init();
