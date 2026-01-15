import fs from 'fs';
import path from 'path';

export interface VideoState {
    url: string;
    time: number;
    paused: boolean;
    timestamp: number;
}

interface ServerState {
    areUserControlsAllowed: boolean;
    isProxyEnabled: boolean;
    currentVideoState: VideoState;
}

const STATE_FILE = path.join(process.cwd(), 'server-state.json');

// 1. Default State
const defaultState: ServerState = {
    areUserControlsAllowed: false,
    isProxyEnabled: true,
    currentVideoState: {
        url: "",
        time: 0,
        paused: true,
        timestamp: Date.now()
    }
};

// 2. Load State from Disk (Synchronous on startup)
let loadedState = defaultState;
try {
    if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        loadedState = { ...defaultState, ...JSON.parse(raw) };

        // If state was playing, calculate elapsed time since crash/restart so we resume at the correct point
        if (!loadedState.currentVideoState.paused) {
            const elapsed = (Date.now() - loadedState.currentVideoState.timestamp) / 1000;
            loadedState.currentVideoState.time += elapsed;
            console.log(`▶ Resuming playback. Advanced time by ${elapsed.toFixed(1)}s`);
        }

        // Always refresh timestamp on boot so future 'elapsed' calcs are relative to NOW
        loadedState.currentVideoState.timestamp = Date.now();

        console.log("💾 State loaded from disk");
    }
} catch (e) {
    console.error("Failed to load state:", e);
}

export const serverState = loadedState;

// 3. Helper to Save State
export const persistState = () => {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(serverState, null, 2));
    } catch (e) {
        console.error("Failed to save state:", e);
    }
};