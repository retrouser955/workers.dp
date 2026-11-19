import { EventEmitter } from "node:events";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { WORKER_SOURCE_DATA_KEY, type WorkerSourceOptions } from "../source";
import type { Payload, WorkerGatewayPayload, WorkerMessage } from "../worker/worker.type";

const IDLE_WORKER_REAP_MS = 30_000;
const TERMINATE_GRACE_MS = 150;
const DEFAULT_MAX_RESPAWNS = 10;

export interface WorkerModeGrow {
    type: "grow";
    guildPerWorker: number;
}

export interface WorkerModeFixed {
    type: "fixed";
    workers: number;
}

export type WorkerMode = WorkerModeGrow | WorkerModeFixed;

export interface WorkerManagerOptions {
    mode: WorkerMode;
    /**
     * Path or URL passed to the Worker constructor.
     * Must point to an entry point Node can execute (a built worker script).
     */
    workerScript: string | URL;
    workerData?: unknown;
    /**
     * Source module registered inside every playback worker.
     * Workers use it to resolve extractor streams without sending a Readable
     * across the thread boundary.
     */
    sources?: WorkerSourceOptions;
    /**
     * How many times an exited worker may be replaced before recovery stops.
     * Bounds a crash loop caused by a broken worker script. Defaults to 10.
     */
    maxRespawns?: number;
}

export interface WorkerManagerEventMap {
    message: [payload: WorkerMessage, worker: Worker];
    gatewayPayload: [payload: unknown, guildId: string, worker: Worker];
    workerCreated: [worker: Worker];
    workerError: [error: Error, worker: Worker];
    workerExit: [code: number, worker: Worker];
    /** A guild was moved to a replacement worker after its previous worker exited. */
    guildReassigned: [guildId: string, worker: Worker, previousWorker: Worker];
}

function isGatewayPayload(message: unknown): message is WorkerGatewayPayload {
    return (
        typeof message === "object" &&
        message !== null &&
        "guild" in message &&
        typeof message.guild === "string" &&
        "payload" in message &&
        !("op" in message)
    );
}

function validateMode(mode: WorkerMode) {
    if (mode.type === "fixed") {
        if (!Number.isInteger(mode.workers) || mode.workers < 1) {
            throw new Error("WorkerModeFixed.workers must be a positive integer");
        }
        return;
    }

    if (!Number.isInteger(mode.guildPerWorker) || mode.guildPerWorker < 1) {
        throw new Error("WorkerModeGrow.guildPerWorker must be a positive integer");
    }
}

export class WorkerManager extends EventEmitter {
    private readonly mode: WorkerMode;
    private readonly workerScript: string | URL;
    private readonly workerData: unknown;
    private readonly sources: WorkerSourceOptions | undefined;
    private readonly maxRespawns: number;
    private readonly workersByGuild = new Map<string, Worker>();
    private readonly guildsByWorker = new Map<Worker, Set<string>>();
    private readonly reapTimers = new Map<Worker, ReturnType<typeof setTimeout>>();
    private readonly terminatingWorkers = new WeakSet<Worker>();
    private nextWorker = 0;
    private respawns = 0;
    private terminated = false;

    constructor(options: WorkerManagerOptions) {
        super();
        validateMode(options.mode);

        this.mode = options.mode;
        this.workerScript = options.workerScript;
        this.workerData = options.workerData;
        this.sources = options.sources;
        this.maxRespawns = options.maxRespawns ?? DEFAULT_MAX_RESPAWNS;

        if (this.mode.type === "fixed") {
            for (let i = 0; i < this.mode.workers; i++) {
                this.spawnWorker();
            }
        }
    }

    /** Number of live workers managed by this instance. */
    get workerCount() {
        return this.guildsByWorker.size;
    }

    /** Number of guilds currently assigned to a worker. */
    get guildCount() {
        return this.workersByGuild.size;
    }

    /** Returns the worker currently owning a guild, if any. */
    getWorker(guildId: string): Worker | undefined {
        return this.workersByGuild.get(guildId);
    }

    /** Whether this manager intentionally stopped a worker (idle reap or shutdown). */
    isTerminatingWorker(worker: Worker): boolean {
        return this.terminatingWorkers.has(worker);
    }

    /** Returns the guilds currently assigned to a worker. */
    getGuilds(worker: Worker): string[] {
        return [...(this.guildsByWorker.get(worker) ?? [])];
    }

    /**
     * Assigns a guild to a worker, creating a worker when needed.
     * The worker receives `GUILD_CREATE` only when the assignment is new.
     */
    addGuild(guildId: string): Worker {
        if (this.terminated) throw new Error("WorkerManager has been terminated");

        const existing = this.workersByGuild.get(guildId);
        if (existing) return existing;

        const worker = this.pickWorker();
        const guilds = this.guildsByWorker.get(worker);
        if (!guilds) throw new Error("Selected worker is not managed by this instance");

        this.cancelReap(worker);
        guilds.add(guildId);
        this.workersByGuild.set(guildId, worker);
        worker.postMessage({ op: "GUILD_CREATE", d: { guildId } } satisfies Payload);

        return worker;
    }

    /**
     * Unassigns a guild and tells its worker to delete it.
     * Returns false when the guild was not assigned.
     */
    removeGuild(guildId: string): boolean {
        const worker = this.workersByGuild.get(guildId);
        if (!worker) return false;

        this.workersByGuild.delete(guildId);
        const guilds = this.guildsByWorker.get(worker);
        guilds?.delete(guildId);
        worker.postMessage({ op: "GUILD_DELETE", d: { guildId } } satisfies Payload);

        if (guilds && guilds.size === 0) this.scheduleReap(worker);

        return true;
    }

    /**
     * Routes a payload to the worker owning its guild.
     * Guild operations auto-assign unknown guilds; voice events are forwarded
     * only for guilds that already have an assignment.
     */
    dispatch(payload: Payload): Worker | undefined {
        if (this.terminated) throw new Error("WorkerManager has been terminated");

        if (payload.op === "VOICE_SERVER_UPDATE" || payload.op === "VOICE_STATE_UPDATE") {
            const guildId = payload.d.guild_id;
            if (!guildId) return undefined;

            const worker = this.workersByGuild.get(guildId);
            worker?.postMessage(payload);
            return worker;
        }

        const { guildId } = payload.d;

        if (payload.op === "GUILD_DELETE") {
            const worker = this.workersByGuild.get(guildId);
            if (worker) this.removeGuild(guildId);
            return worker;
        }

        const worker = this.addGuild(guildId);
        if (payload.op !== "GUILD_CREATE") {
            worker.postMessage(payload);
        }

        return worker;
    }

    /** Stops every worker and clears all assignments. */
    async terminate(): Promise<void> {
        if (this.terminated) return;
        this.terminated = true;

        for (const timer of this.reapTimers.values()) {
            clearTimeout(timer);
        }
        this.reapTimers.clear();

        const workers = [...this.guildsByWorker.keys()];

        for (const [guildId, worker] of this.workersByGuild) {
            worker.postMessage({ op: "GUILD_DELETE", d: { guildId } } satisfies Payload);
        }

        // A worker thread cannot send the OP 4 leave packet after it is killed.
        // Give the workers one turn to process the delete before terminating.
        if (this.workersByGuild.size > 0) await delay(TERMINATE_GRACE_MS);

        this.workersByGuild.clear();
        this.guildsByWorker.clear();

        for (const worker of workers) this.terminatingWorkers.add(worker);

        await Promise.all(workers.map((worker) => worker.terminate()));
    }

    private pickWorker(): Worker {
        if (this.mode.type === "grow") {
            let selected: Worker | undefined;
            let leastGuilds = Infinity;

            for (const [worker, guilds] of this.guildsByWorker) {
                if (guilds.size >= this.mode.guildPerWorker) continue;
                if (guilds.size < leastGuilds) {
                    selected = worker;
                    leastGuilds = guilds.size;
                }
            }

            return selected ?? this.spawnWorker();
        }

        const workers = [...this.guildsByWorker.keys()];
        if (workers.length === 0) return this.spawnWorker();

        const worker = workers[this.nextWorker % workers.length];
        this.nextWorker++;

        return worker ?? this.spawnWorker();
    }

    private spawnWorker(): Worker {
        const workerData =
            this.sources === undefined
                ? this.workerData
                : {
                      [WORKER_SOURCE_DATA_KEY]: {
                          sources: this.sources,
                          userData: this.workerData
                      }
                  };

        const worker = new Worker(this.workerScript, { workerData });

        this.guildsByWorker.set(worker, new Set());

        worker.on("message", (message: unknown) => {
            if (isGatewayPayload(message)) {
                this.emit("gatewayPayload", message.payload, message.guild, worker);
                return;
            }

            this.emit("message", message as WorkerMessage, worker);
        });

        worker.on("error", (error: Error) => {
            this.emit("workerError", error, worker);
        });

        worker.on("exit", (code) => {
            this.handleWorkerExit(worker, code);
        });

        this.emit("workerCreated", worker);

        return worker;
    }

    private handleWorkerExit(worker: Worker, code: number) {
        const guilds = [...(this.guildsByWorker.get(worker) ?? [])];

        this.cancelReap(worker);
        this.guildsByWorker.delete(worker);

        for (const guildId of guilds) {
            if (this.workersByGuild.get(guildId) === worker) {
                this.workersByGuild.delete(guildId);
            }
        }

        this.emit("workerExit", code, worker);

        if (this.terminated || guilds.length === 0) return;

        if (this.respawns >= this.maxRespawns) {
            this.emit(
                "workerError",
                new Error(
                    `Worker exited with code ${code} and the respawn limit (${this.maxRespawns}) has been reached; ` +
                    `${guilds.length} guild(s) are no longer assigned`
                ),
                worker
            );
            return;
        }

        this.respawns++;

        if (this.mode.type === "fixed") this.spawnWorker();

        for (const guildId of guilds) {
            const replacement = this.pickWorker();
            const owned = this.guildsByWorker.get(replacement);
            if (!owned) continue;

            this.cancelReap(replacement);
            owned.add(guildId);
            this.workersByGuild.set(guildId, replacement);
            replacement.postMessage({ op: "GUILD_CREATE", d: { guildId } } satisfies Payload);
            this.emit("guildReassigned", guildId, replacement, worker);
        }
    }

    private scheduleReap(worker: Worker) {
        // Fixed pools keep their configured size; only grow-mode workers that were
        // spawned for a guild are reaped once their guilds move away.
        if (this.mode.type !== "grow") return;
        if (this.reapTimers.has(worker) || this.terminated) return;

        const timer = setTimeout(() => {
            this.reapTimers.delete(worker);
            if (this.terminated) return;
            if ((this.guildsByWorker.get(worker)?.size ?? 0) > 0) return;

            this.terminatingWorkers.add(worker);
            this.guildsByWorker.delete(worker);
            void worker.terminate();
        }, IDLE_WORKER_REAP_MS);

        timer.unref();
        this.reapTimers.set(worker, timer);
    }

    private cancelReap(worker: Worker) {
        const timer = this.reapTimers.get(worker);
        if (!timer) return;

        clearTimeout(timer);
        this.reapTimers.delete(worker);
    }

    on<K extends keyof WorkerManagerEventMap>(
        event: K,
        listener: (...args: WorkerManagerEventMap[K]) => void
    ): this;
    on(event: string | symbol, listener: (...args: any[]) => void): this;
    on(event: string | symbol, listener: (...args: any[]) => void): this {
        return super.on(event, listener);
    }
}
