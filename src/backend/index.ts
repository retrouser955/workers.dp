import type {
    PlaybackBackend,
    PlaybackBackendCapabilities,
    PlaybackBackendContext,
    PlaybackSession,
    PlaybackSessionOptions
} from "discord-player";
import type { APIVoiceState, GatewayVoiceServerUpdateDispatchData } from "discord-api-types/v10";
import type { Worker } from "node:worker_threads";
import { WorkerManager, type WorkerManagerOptions } from "../manager/worker-manager";
import { WorkerPlaybackSession } from "../playback";
import type { Payload } from "../worker/worker.type";

type GatewayVoicePayload = Parameters<PlaybackBackendContext["send"]>[1];

export interface WorkerBackendOptions extends WorkerManagerOptions {
    /** Default deadline for worker requests issued by sessions. */
    requestTimeoutMs?: number;
    /** Default deadline for voice connections established by sessions. */
    connectTimeoutMs?: number;
}

const WORKER_BACKEND_ID = "tech.1980s.discord-player-worker.backend";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isVoiceGatewayPayload(payload: unknown): payload is GatewayVoicePayload {
    if (!isRecord(payload) || payload.op !== 4 || !isRecord(payload.d)) return false;
    return typeof payload.d.guild_id === "string";
}

export class WorkerBackend implements PlaybackBackend {
    readonly id = WORKER_BACKEND_ID;
    readonly capabilities: PlaybackBackendCapabilities = {
        // Sessions still accept only serialisable descriptors. Extractor
        // Readables are consumed by the worker and never cross this boundary.
        sources: ["url", "file", "buffer"],
        crossfade: false,
        filters: true
    };

    private readonly options: WorkerBackendOptions;
    private readonly sessions = new Set<WorkerPlaybackSession>();
    private manager: WorkerManager | null = null;
    private context: PlaybackBackendContext | null = null;
    private disposal: Promise<void> | null = null;

    private readonly onAbort = () => {
        void this.destroy().catch((error: unknown) => {
            console.error("Worker playback backend shutdown failed", error);
        });
    };

    private readonly onGatewayPayload = (payload: unknown, guildId: string) => {
        const context = this.context;
        if (!context || this.disposal) return;
        if (!isVoiceGatewayPayload(payload) || payload.d.guild_id !== guildId) return;

        Promise.resolve(context.send(guildId, payload)).catch((error: unknown) => {
            console.error(
                `Worker playback backend could not send the Gateway payload for guild ${guildId}`,
                error
            );
        });
    };

    private readonly onWorkerError = (error: Error) => {
        console.error("Worker playback thread failed", error);
    };

    private readonly onWorkerExit = (code: number, worker: Worker) => {
        if (code === 0) return;
        if (this.manager?.isTerminatingWorker(worker)) return;
        console.error(`Worker playback thread exited with code ${code}`);
    };

    constructor(options: WorkerBackendOptions) {
        this.options = options;
    }

    async initialize(context: PlaybackBackendContext): Promise<void> {
        if (this.manager || this.disposal) {
            throw new Error("Worker playback backend has already been initialized");
        }

        context.signal.throwIfAborted();

        const manager = new WorkerManager({
            mode: this.options.mode,
            workerScript: this.options.workerScript,
            ...(this.options.workerData === undefined
                ? {}
                : { workerData: this.options.workerData }),
            ...(this.options.sources === undefined
                ? {}
                : { sources: this.options.sources }),
            ...(this.options.maxRespawns === undefined
                ? {}
                : { maxRespawns: this.options.maxRespawns })
        });

        this.manager = manager;
        this.context = context;

        // Sessions and the backend share this emitter; the default limit of ten
        // listeners would warn once a handful of guilds are active.
        manager.setMaxListeners(0);

        manager.on("gatewayPayload", this.onGatewayPayload);
        manager.on("workerError", this.onWorkerError);
        manager.on("workerExit", this.onWorkerExit);
        context.signal.addEventListener("abort", this.onAbort, { once: true });

        if (context.signal.aborted) {
            await this.destroy();
            context.signal.throwIfAborted();
        }
    }

    receive(packet: Record<string, unknown>): void {
        const manager = this.manager;
        if (!manager || this.disposal || !isRecord(packet.d)) return;

        if (packet.t === "GUILD_DELETE") {
            const guildId = packet.d.id;
            if (typeof guildId !== "string") return;

            // The bot is no longer in this guild; release every session so the
            // worker pools and voice connections do not outlive it.
            for (const session of [...this.sessions]) {
                if (session.guildId !== guildId) continue;
                void session.dispose().catch((error: unknown) => {
                    console.error(
                        `Worker playback backend could not dispose the session for guild ${guildId}`,
                        error
                    );
                });
            }
            return;
        }

        if (typeof packet.d.guild_id !== "string") return;

        switch (packet.t) {
            case "VOICE_STATE_UPDATE": {
                // @discordjs/voice stores the latest packet as the bot's own state.
                // Forwarding another member's update would overwrite its session and user IDs.
                if (packet.d.user_id !== this.context?.clientId) return;

                manager.dispatch({
                    op: "VOICE_STATE_UPDATE",
                    d: packet.d as unknown as APIVoiceState
                } satisfies Payload);
                break;
            }
            case "VOICE_SERVER_UPDATE": {
                manager.dispatch({
                    op: "VOICE_SERVER_UPDATE",
                    d: packet.d as unknown as GatewayVoiceServerUpdateDispatchData
                } satisfies Payload);
                break;
            }
        }
    }

    createSession(options: PlaybackSessionOptions, signal: AbortSignal): PlaybackSession {
        const manager = this.manager;
        if (!manager || this.disposal) {
            throw new Error("Worker playback backend is not initialized");
        }

        signal.throwIfAborted();

        const session = new WorkerPlaybackSession(options, manager, signal, {
            ...(this.options.requestTimeoutMs === undefined
                ? {}
                : { requestTimeoutMs: this.options.requestTimeoutMs }),
            ...(this.options.connectTimeoutMs === undefined
                ? {}
                : { connectTimeoutMs: this.options.connectTimeoutMs })
        });

        this.sessions.add(session);
        session.on("sessionDisposed", () => {
            this.sessions.delete(session);
        });

        return session;
    }

    destroy(): Promise<void> {
        this.disposal ??= this.performDestroy();
        return this.disposal;
    }

    private async performDestroy(): Promise<void> {
        const manager = this.manager;
        const context = this.context;

        this.manager = null;
        this.context = null;

        context?.signal.removeEventListener("abort", this.onAbort);
        manager?.off("gatewayPayload", this.onGatewayPayload);
        manager?.off("workerError", this.onWorkerError);
        manager?.off("workerExit", this.onWorkerExit);

        const sessions = [...this.sessions];
        this.sessions.clear();
        await Promise.allSettled(sessions.map((session) => session.dispose()));

        await manager?.terminate();
    }
}
