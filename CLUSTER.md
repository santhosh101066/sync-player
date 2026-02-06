# Cluster Mode Configuration

## ⚠️ Important: WebSocket Limitation

**Current Status:** Cluster mode has **limited WebSocket support** due to Socket.IO session management.

**Issue:** Each worker maintains its own Socket.IO sessions in memory. When a client connects to Worker 1 but subsequent requests route to Worker 2, you'll see `{"code":1,"message":"Session ID unknown"}` errors.

**Recommended Approach:**
- **Development & Small Deployments**: Use `npm run dev` (single worker)
- **Production with WebSockets**: Use `npm run start` (single worker) or implement Redis adapter
- **Production without WebSockets**: Use `npm run start:cluster` (multi-worker)

**Future Enhancement:** To fully support clustering with WebSockets, we need to implement a Redis adapter for Socket.IO to share sessions across workers.

## Overview

The server now supports **cluster mode** to spawn multiple worker processes, allowing it to:
- Handle more concurrent connections
- Utilize multiple CPU cores
- Improve overall throughput and performance
- Auto-restart workers if they crash

## Configuration

### Environment Variable

Add to `.env`:
```bash
WORKERS=4  # Number of worker processes (default: half of CPU cores, minimum 2)
```

**Recommendations:**
- **Development**: Use `npm run dev` (single worker for easier debugging)
- **Production**: Use `npm run start:cluster` with `WORKERS=4` or more
- **Optimal**: Set `WORKERS` to number of CPU cores (e.g., 4-8 for most servers)
- **High Load**: Can go up to 2x CPU cores if handling many concurrent streams

### Running Cluster Mode

**Development (Single Worker):**
```bash
npm run dev
```

**Production (Multi-Worker):**
```bash
npm run start:cluster
```

Or with custom worker count:
```bash
WORKERS=8 npm run start:cluster
```

## How It Works

1. **Master Process**: Spawns and manages worker processes
2. **Worker Processes**: Each runs a full copy of the server
3. **Load Balancing**: OS automatically distributes incoming connections across workers
4. **Auto-Recovery**: If a worker crashes, master automatically spawns a new one

## Architecture

```
┌─────────────────────────────────────┐
│   Master Process (cluster.ts)      │
│   - Spawns workers                  │
│   - Monitors health                 │
│   - Auto-restarts on crash          │
└──────────┬──────────────────────────┘
           │
    ┌──────┴──────┬──────┬──────┐
    │             │      │      │
┌───▼───┐   ┌───▼───┐  ...   ┌───▼───┐
│Worker1│   │Worker2│        │WorkerN│
│:8000  │   │:8000  │        │:8000  │
└───────┘   └───────┘        └───────┘
```

## Performance Benefits

**Single Worker (default `npm run dev`):**
- ✅ Easy debugging
- ✅ Simple logs
- ❌ Limited to 1 CPU core
- ❌ Lower concurrent connection limit

**Cluster Mode (`npm run start:cluster`):**
- ✅ Utilizes all CPU cores
- ✅ 2-8x more concurrent connections
- ✅ Better video streaming performance
- ✅ Auto-recovery from crashes
- ⚠️ Slightly more complex logs (shows worker PID)

## Monitoring

Logs will show:
```
🚀 Master process 12345 is running
📊 Spawning 4 workers (8 CPUs available)
✅ Worker 12346 is online
✅ Worker 12347 is online
✅ Worker 12348 is online
✅ Worker 12349 is online
🚀 SyncStream running on http://0.0.0.0:8000
```

If a worker crashes:
```
⚠️ Worker 12346 died (SIGTERM). Restarting...
✅ Worker 12350 is online
```

## WebSocket Considerations

**Important**: With clustering, WebSocket connections are sticky to a single worker. This means:
- Each user connects to one specific worker
- Room synchronization works within that worker
- For multi-server deployments, consider Redis adapter (not included yet)

## When to Use Cluster Mode

**Use Cluster Mode When:**
- Running in production
- Expecting 10+ concurrent users
- Streaming high-quality videos (1080p+)
- Server has 4+ CPU cores
- Need high availability (auto-restart)

**Use Single Worker When:**
- Developing locally
- Debugging issues
- Running on low-resource VPS (1-2 cores)
- Testing new features

## Troubleshooting

**Issue**: Workers keep crashing
- Check logs for errors in worker processes
- Reduce `WORKERS` count
- Check memory usage (`htop` or `top`)

**Issue**: No performance improvement
- Ensure you're actually hitting CPU limits (check with `htop`)
- Video streaming is often I/O bound, not CPU bound
- Consider optimizing network/disk instead

**Issue**: Port already in use
- Only one master process can bind to port 8000
- Kill existing processes: `pkill -f "ts-node"`

## Advanced: Production Deployment

For production with PM2:
```bash
# Install PM2
npm install -g pm2

# Start with cluster mode
pm2 start src/cluster.ts --name syncplayer -i 4

# Monitor
pm2 monit

# Auto-restart on system reboot
pm2 startup
pm2 save
```

## Performance Metrics

Expected improvements with 4 workers vs 1 worker:
- **Concurrent Users**: 4x increase (40-80 users vs 10-20)
- **Request Throughput**: 3-4x increase
- **CPU Utilization**: 80-100% vs 25%
- **Video Stream Handling**: 4x simultaneous streams
