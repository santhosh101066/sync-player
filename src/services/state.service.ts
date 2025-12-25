export interface VideoState {
    url: string;
    time: number;
    paused: boolean;
    timestamp: number;
}

export const serverState = {
    areUserControlsAllowed: false,
    isProxyEnabled: true,
    currentVideoState: {
        url: "",
        time: 0,
        paused: true,
        timestamp: Date.now()
    } as VideoState
};
