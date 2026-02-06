import cluster from "cluster";
import os from "os";
import { logger } from "./services/logger.service";

const numCPUs = os.cpus().length;
const WORKERS = process.env.WORKERS ? parseInt(process.env.WORKERS, 10) : Math.max(2, Math.floor(numCPUs / 2));

if (cluster.isPrimary) {
    logger.info(`🚀 Master process ${process.pid} is running`);
    logger.info(`📊 Spawning ${WORKERS} workers (${numCPUs} CPUs available)`);
    logger.warn(`⚠️  WebSocket sticky sessions enabled (required for Socket.IO)`);

    const workers: any[] = [];

    // Fork workers
    for (let i = 0; i < WORKERS; i++) {
        const worker = cluster.fork();
        workers.push(worker);
    }

    cluster.on("exit", (worker, code, signal) => {
        logger.warn(`⚠️ Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
        const newWorker = cluster.fork();
        const index = workers.indexOf(worker);
        if (index !== -1) workers[index] = newWorker;
    });

    cluster.on("online", (worker) => {
        logger.info(`✅ Worker ${worker.process.pid} is online`);
    });
} else {
    // Worker processes run the actual server
    require("./index");
    logger.info(`👷 Worker ${process.pid} started`);
}
