import {
    ExtractorExecutionContext,
    PluginError,
    PluginRegistry,
    SearchResult,
    Track,
    deserialize,
    type ExecuteOptions,
    type LegacyPlayerContext,
    type SerializedTrack,
    type SourceMatch,
    type SourceQuery
} from "discord-player";
import { isAbsolute, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import type { MediaSourceDescriptor, PlayableMediaSource } from "../audio";

/** Reserved workerData key used by WorkerManager to forward source configuration. */
export const WORKER_SOURCE_DATA_KEY = "__workersDpSources";

/** Internal URL scheme used to carry a Track from the main thread to a worker. */
export const SOURCE_TOKEN_PREFIX = "workers.dp:source:";

const MAX_SOURCE_TOKEN_LENGTH = 512 * 1024;
const MAX_PORTABLE_RAW_LENGTH = 256 * 1024;

export interface SourceRuntimeOptions {
    /** Source IDs disabled for both matching and stream resolution. */
    blockExtractors?: readonly string[];
    /** Compatibility probe timeout hint forwarded to extractors. */
    probeTimeout?: number;
}

export interface WorkerSourceOptions extends SourceRuntimeOptions {
    /**
     * Module that exports `registerSources(runtime, options)`.
     * Absolute and relative paths are resolved from `process.cwd()`; package
     * specifiers and `file:` URLs are passed to Node unchanged.
     */
    module: string;
    /** Structured-cloneable options passed to `registerSources`. */
    options?: unknown;
    /** Deadline for resolving one Track inside a worker. Defaults to 30 seconds. */
    resolveTimeoutMs?: number;
}

export type SourceRegistrar = (runtime: SourceRuntime, options: unknown) => void | Promise<void>;

type MediaSourceResult = Awaited<ReturnType<PluginRegistry["resolveStream"]>>;

interface SourceTokenPayload {
    track: SerializedTrack;
    raw?: unknown;
    sourceState?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/**
 * Standalone source host used by the main thread for queries and by each worker
 * for stream resolution.
 *
 * It deliberately exposes no Remedia client: tracks that require a remote
 * source node cannot be played by this backend.
 */
export class SourceRuntime {
    readonly plugins: PluginRegistry;
    readonly extractors: ExtractorExecutionContext;
    readonly options: SourceRuntimeOptions;

    constructor(options: SourceRuntimeOptions = {}) {
        this.options = {
            ...(options.blockExtractors === undefined
                ? {}
                : { blockExtractors: options.blockExtractors }),
            ...(options.probeTimeout === undefined ? {} : { probeTimeout: options.probeTimeout })
        };

        const context = this as unknown as LegacyPlayerContext;
        this.plugins = new PluginRegistry(context, () => this.options.blockExtractors ?? []);
        this.extractors = new ExtractorExecutionContext(context);
    }

    getRemedia(throwOnMissing = true): null {
        if (throwOnMissing) {
            throw new Error(
                "The worker source runtime does not provide an audio client; use an embedded source provider"
            );
        }

        return null;
    }

    debug(_message: string): void {
        // Standalone source diagnostics are intentionally ignored.
    }

    emit(): boolean {
        return false;
    }

    async destroy(): Promise<void> {
        await this.plugins.destroy();
    }

    /** Collect source matches without resolving them. */
    async match(input: SourceQuery, execution: ExecuteOptions = {}): Promise<SourceMatch[]> {
        await this.plugins.ready();
        const prepared = this.normalize(input, execution);
        const target = this.targetProvider(prepared.input);
        return target ? [{ pluginId: target, score: 0 }] : this.matchPrepared(prepared.input, prepared.execution);
    }

    /** Search using the same provider selection rules as Discord Player. */
    async search(input: SourceQuery, execution: ExecuteOptions = {}): Promise<SearchResult> {
        await this.plugins.ready();
        const prepared = this.normalize(input, execution);
        let query = prepared.input;

        if (this.plugins.hasCapability("search.beforeQuery")) {
            const transformed = await this.plugins.execute(
                "search.beforeQuery",
                query,
                prepared.execution
            );

            if (!transformed || typeof transformed.query !== "string") {
                throw new TypeError("search.beforeQuery requires a string query.");
            }

            query = { ...query, ...transformed };
        }

        const target = this.targetProvider(query);
        const matches = target
            ? [{ pluginId: target, score: 0 }]
            : await this.matchPrepared(query, prepared.execution);
        const failures: PluginError[] = [];

        for (const match of matches) {
            if (!match.pluginId || !Number.isFinite(match.score) || match.score < 0) continue;

            let result;
            try {
                result = await this.plugins.execute("search.query.resolve", query, {
                    ...prepared.execution,
                    pluginId: match.pluginId,
                    ...(match.hostId === undefined ? {} : { hostId: match.hostId })
                });
            } catch (error) {
                if (
                    error instanceof PluginError &&
                    error.operation === "search.query.resolve" &&
                    error.pluginId === match.pluginId
                ) {
                    failures.push(error);
                    continue;
                }

                throw error;
            }

            if (!result || result.tracks.length === 0) continue;

            for (const track of result.tracks) {
                track.sourceReference ??= {
                    pluginId: match.pluginId,
                    data: { url: track.url }
                };

                if (query.options?.requestedBy !== undefined) {
                    track.requestedBy = query.options.requestedBy;
                }
            }

            const data = this.plugins.hasCapability("search.afterResults")
                ? await this.plugins.execute(
                      "search.afterResults",
                      { tracks: result.tracks, playlist: result.playlist ?? null },
                      prepared.execution
                  )
                : { tracks: result.tracks, playlist: result.playlist ?? null };

            if (
                !data ||
                !Array.isArray(data.tracks) ||
                !data.tracks.every((track) => track instanceof Track)
            ) {
                throw new TypeError("search.afterResults requires Track instances.");
            }

            return new SearchResult({
                tracks: data.tracks,
                playlist: data.playlist ?? null
            });
        }

        const failure = failures[0];
        if (failure) {
            if (failures.length === 1) throw failure;

            throw new AggregateError(
                failures,
                `All matching source providers failed during search: ${failures
                    .map((error) => error.message)
                    .join("; ")}`,
                { cause: failure }
            );
        }

        return SearchResult.empty();
    }

    private targetProvider(input: SourceQuery): string | undefined {
        const hint = input.providerHint;
        if (!hint) return undefined;
        return this.plugins.has(hint) || this.extractors.isRegistered(hint) ? hint : undefined;
    }

    private async matchPrepared(input: SourceQuery, execution: ExecuteOptions): Promise<SourceMatch[]> {
        if (input.protocol) {
            return this.plugins.protocolMatches(input.protocol, execution).map(
                ({ hostId, ...match }) =>
                    hostId === undefined ? match : { ...match, hostId }
            );
        }

        const matches = await this.plugins.execute("search.query.match", input, execution);
        return matches.filter((match): match is SourceMatch => match !== null);
    }

    private normalize(
        input: SourceQuery,
        execution: ExecuteOptions
    ): { input: SourceQuery; execution: ExecuteOptions } {
        if (input.protocol) return { input, execution };
        if (/^(?:https?|file):/i.test(input.query)) return { input, execution };
        if (/^[a-z]:[\\/]/i.test(input.query)) return { input, execution };

        const prefix = /^([a-z][a-z0-9+.-]*):(?:\/\/)?(.*)$/is.exec(input.query);
        const protocol = prefix?.[1];
        if (!protocol || !this.plugins.supportsProtocol(protocol, execution)) {
            return { input, execution };
        }

        return {
            input: { ...input, query: prefix[2] ?? "", protocol },
            execution
        };
    }
}

/** Load the user source module and register its providers in `runtime`. */
export async function loadSourceRuntime(options: WorkerSourceOptions): Promise<SourceRuntime> {
    const runtime = new SourceRuntime(options);

    try {
        const module = await importSourceModule(options.module);
        const register = module.registerSources ?? module.default;

        if (typeof register !== "function") {
            throw new TypeError(
                `Source module "${options.module}" must export registerSources(runtime, options)`
            );
        }

        await (register as SourceRegistrar)(runtime, options.options);
        return runtime;
    } catch (error) {
        await runtime.destroy().catch(() => {});
        throw error;
    }
}

/** Read the source configuration forwarded through workerData, when present. */
export function readWorkerSourceOptions(workerData: unknown): WorkerSourceOptions | undefined {
    if (!isRecord(workerData)) return undefined;

    const envelope = workerData[WORKER_SOURCE_DATA_KEY];
    if (!isRecord(envelope)) return undefined;

    const sources = envelope.sources;
    if (!isRecord(sources) || typeof sources.module !== "string" || sources.module.length === 0) {
        return undefined;
    }

    const result: WorkerSourceOptions = { module: sources.module };

    if (
        Array.isArray(sources.blockExtractors) &&
        sources.blockExtractors.every((value) => typeof value === "string")
    ) {
        result.blockExtractors = sources.blockExtractors as string[];
    }

    if (typeof sources.probeTimeout === "number" && Number.isFinite(sources.probeTimeout)) {
        result.probeTimeout = sources.probeTimeout;
    }

    if (
        typeof sources.resolveTimeoutMs === "number" &&
        Number.isFinite(sources.resolveTimeoutMs) &&
        sources.resolveTimeoutMs > 0
    ) {
        result.resolveTimeoutMs = sources.resolveTimeoutMs;
    }

    if ("options" in sources) result.options = sources.options;

    return result;
}

/** Whether a playback URL is a serialized Track produced by this plugin. */
export function isSourceToken(url: string): boolean {
    return url.startsWith(SOURCE_TOKEN_PREFIX);
}

/** Serialize a Track into a transport-safe URL for a worker-side source host. */
export function encodeSourceToken(track: Track): string {
    const payload: SourceTokenPayload = { track: track.serialize() };

    const raw = portableRaw(track.raw);
    if (raw !== undefined) payload.raw = raw;
    if (typeof track.sourceState === "string") payload.sourceState = track.sourceState;

    const token =
        SOURCE_TOKEN_PREFIX +
        Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

    if (token.length > MAX_SOURCE_TOKEN_LENGTH) {
        throw new Error("The serialized Track is too large to transfer to a playback worker");
    }

    return token;
}

/** Decode a URL produced by {@link encodeSourceToken}. */
export function decodeSourceToken(url: string): SourceTokenPayload {
    if (!isSourceToken(url)) throw new Error("Not a worker source token");

    const encoded = url.slice(SOURCE_TOKEN_PREFIX.length);
    if (!encoded || encoded.length > MAX_SOURCE_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
        throw new Error("Invalid worker source token");
    }

    let payload: unknown;
    try {
        payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
        throw new Error("Invalid worker source token payload");
    }

    if (!isRecord(payload) || !isRecord(payload.track)) {
        throw new Error("Invalid worker source token payload");
    }

    if (payload.raw !== undefined && !isRecord(payload.raw)) {
        throw new Error("Invalid worker source token payload");
    }

    if (payload.sourceState !== undefined && typeof payload.sourceState !== "string") {
        throw new Error("Invalid worker source token payload");
    }

    return payload as unknown as SourceTokenPayload;
}

/**
 * Resolve a worker-bound resource. Ordinary URL, file, and buffer descriptors
 * pass through unchanged; source tokens are restored and resolved by the
 * worker-owned source runtime.
 */
export async function resolveWorkerSource(
    runtime: SourceRuntime | null,
    resource: MediaSourceDescriptor,
    guildId: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<PlayableMediaSource> {
    if (!("url" in resource) || !isSourceToken(resource.url)) return resource;

    if (!runtime) {
        throw new Error(
            "This Track must be resolved inside a worker, but no source module is configured"
        );
    }

    const payload = decodeSourceToken(resource.url);
    const track = deserialize(payload.track);
    if (!(track instanceof Track)) {
        throw new Error("Invalid worker source token payload");
    }

    if (payload.raw !== undefined) {
        if (!isRecord(payload.raw)) {
            throw new Error("Invalid worker source token payload");
        }

        for (const [key, value] of Object.entries(payload.raw)) {
            if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
            track.raw[key] = value;
        }
    }

    if (payload.sourceState !== undefined) track.sourceState = payload.sourceState;

    // The resolution signal becomes the stream's lifetime in
    // `resolveTrackStream`. Use a controller with a cleared timer so a timeout
    // bounds only resolution and cannot destroy a stream mid-playback.
    const controller = new AbortController();
    const timer =
        options.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                  controller.abort(
                      new Error(`Source resolution timed out after ${options.timeoutMs}ms`)
                  );
              }, options.timeoutMs);

    const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;

    try {
        const source = await runtime.plugins.resolveStream(track, { guildId, signal });
        return toPlayableSource(source);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function toPlayableSource(source: MediaSourceResult): PlayableMediaSource {
    if ("url" in source && typeof source.url === "string") return { url: source.url };
    if ("file" in source && typeof source.file === "string") return { file: source.file };
    if ("stream" in source) return { stream: source.stream };
    if ("buffer" in source) return { buffer: source.buffer };

    throw new Error(
        "Worker playback cannot execute a plugin operation source; use a provider that returns a URL, file, buffer, or Readable"
    );
}

function portableRaw(raw: unknown): unknown {
    if (raw === undefined || raw === null) return undefined;

    try {
        const serialized = JSON.stringify(raw);
        if (serialized === undefined || serialized.length > MAX_PORTABLE_RAW_LENGTH) {
            return undefined;
        }

        return JSON.parse(serialized) as unknown;
    } catch {
        // Extractors may attach non-JSON engine handles. Those are process-local.
        return undefined;
    }
}

function importSourceModule(specifier: string): Promise<Record<string, unknown>> {
    return import(toImportSpecifier(specifier)) as Promise<Record<string, unknown>>;
}

function toImportSpecifier(specifier: string): string {
    if (isAbsolute(specifier)) return pathToFileURL(specifier).href;
    if (specifier.startsWith(".")) return pathToFileURL(resolve(process.cwd(), specifier)).href;
    return specifier;
}
