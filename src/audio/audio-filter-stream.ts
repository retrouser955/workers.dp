import { registerMediabunnyServer } from "@mediabunny/server";
import { AsyncQueue } from "discord-player/dist/utils/async-queue";
import {
    ALL_FORMATS,
    AudioSampleSink,
    BufferSource,
    FilePathSource,
    Input,
    ReadableStreamSource,
    UrlSource,
    type AudioSample,
    type InputAudioTrack,
    type Source
} from "mediabunny";
import {
    AV_CHANNEL_LAYOUT_5POINT0,
    AV_CHANNEL_LAYOUT_5POINT1,
    AV_CHANNEL_LAYOUT_6POINT1,
    AV_CHANNEL_LAYOUT_7POINT1,
    AV_CHANNEL_LAYOUT_MONO,
    AV_CHANNEL_LAYOUT_QUAD,
    AV_CHANNEL_LAYOUT_STEREO,
    AV_CHANNEL_ORDER_UNSPEC,
    AV_SAMPLE_FMT_FLT,
    FilterAPI,
    FilterGraph,
    Frame,
    type ChannelLayout
} from "node-av";
import { PassThrough, Readable } from "node:stream";

// Registers the libavcodec decoders that Mediabunny uses for compressed audio.
// It is idempotent, so importing this module more than once is safe.
registerMediabunnyServer();

const FILTER_CHANGE_LOCK = "queue.operations.filterchange";
export const OUTPUT_FORMAT = "aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo";

export class FilterAPIOutdatedError extends Error {
    constructor() {
        super("The Filter API is outdated.");
    }
}

/**
 * Serialisable description of one resource sent to a playback worker.
 *
 * The main thread only sends URL, file, and buffer descriptors. Workers
 * resolve extractor output locally, so a resolved stream never crosses the
 * worker boundary.
 */
export type MediaSourceDescriptor =
    | { url: string }
    | { file: string }
    | { buffer: Uint8Array };

/**
 * An input accepted by {@link createFilterStream}.
 *
 * A Readable is only valid inside the worker that created it. It is used for
 * extractors that return encoded bytes through a Node stream.
 */
export type PlayableMediaSource =
    | MediaSourceDescriptor
    | { stream: Readable };

/** Metadata read while opening a source, reported to the playback session. */
export interface FilterStreamInfo {
    durationMs: number | null;
    codec: string | null;
    sampleRate: number | null;
    channels: number | null;
}

function createMediaSource(source: PlayableMediaSource): Source {
    if ("url" in source) return new UrlSource(source.url);
    if ("file" in source) return new FilePathSource(source.file);
    if ("buffer" in source) return new BufferSource(source.buffer);

    // A worker-side extractor produced an append-only encoded stream. Mediabunny
    // cannot seek it, but sequential formats decode normally.
    return new ReadableStreamSource(Readable.toWeb(source.stream) as ReadableStream<Uint8Array>, {
        handleUnhandledError: (error) => {
            source.stream.destroy(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

const CHANNEL_LAYOUTS: ReadonlyMap<number, ChannelLayout> = new Map([
    [1, AV_CHANNEL_LAYOUT_MONO],
    [2, AV_CHANNEL_LAYOUT_STEREO],
    [4, AV_CHANNEL_LAYOUT_QUAD],
    [5, AV_CHANNEL_LAYOUT_5POINT0],
    [6, AV_CHANNEL_LAYOUT_5POINT1],
    [7, AV_CHANNEL_LAYOUT_6POINT1],
    [8, AV_CHANNEL_LAYOUT_7POINT1]
]);

function channelLayoutFor(channels: number): ChannelLayout {
    return CHANNEL_LAYOUTS.get(channels) ?? {
        nbChannels: channels,
        order: AV_CHANNEL_ORDER_UNSPEC,
        mask: 0n
    };
}

/**
 * Copies an {@link AudioSample} into a `node-av` frame.
 *
 * `@mediabunny/server`'s `toAvFrame` cannot be used here: it is built against
 * its own `node-av` copy, so it rejects frames created by this package's
 * `node-av`. Converting interleaved float samples directly keeps a single
 * `node-av` instance in the filter graph.
 */
function createAudioFrame(sample: AudioSample): Frame {
    const planeIndex = 0;
    const format = "f32";
    const buffer = Buffer.allocUnsafe(sample.allocationSize({ planeIndex, format }));
    sample.copyTo(buffer, { planeIndex, format });

    return Frame.fromAudioBuffer(buffer, {
        nbSamples: sample.numberOfFrames,
        format: AV_SAMPLE_FMT_FLT,
        sampleRate: sample.sampleRate,
        channelLayout: channelLayoutFor(sample.numberOfChannels),
        timeBase: { num: 1, den: sample.sampleRate },
        pts: BigInt(Math.round(sample.timestamp * sample.sampleRate))
    });
}

async function probeInfo(track: InputAudioTrack): Promise<FilterStreamInfo> {
    const [codec, sampleRate, channels, durationSeconds] = await Promise.all([
        track.getCodec().catch(() => null),
        track.getSampleRate().catch(() => null),
        track.getNumberOfChannels().catch(() => null),
        track.computeDurationOrNull().catch(() => null)
    ]);

    return {
        codec: codec ?? null,
        sampleRate: Number.isFinite(sampleRate) ? (sampleRate as number) : null,
        channels: Number.isFinite(channels) ? (channels as number) : null,
        durationMs:
            durationSeconds === null || !Number.isFinite(durationSeconds)
                ? null
                : Math.max(0, Math.round(durationSeconds * 1000))
    };
}

export function removeTrailingCommas(input: string) {
    const result = input.replace(/^,|,$/g, '');
    return result;
}

/**
 * Verify an audio filter string
 * @param filter The filter string to verify
 * @returns Whether the filter string can be parsed
 */
export function verifyAudioFilter(filter: string) {
    const graph = new FilterGraph();

    try {
        graph.alloc();
        const ffOpCode = graph.parse(filter, null, null);
        return !(ffOpCode < 0);
    } catch (error) {
        return false;
    } finally {
        graph.free();
    }
}

/**
 * Concatinate a filter string by removing its trailing commas an joining them together
 * @param filters The filter strings to Concatinate
 * @returns The concatinated filter string
 */
export function concatFilterString(...filters: string[]) {
    return removeTrailingCommas(filters.map(v => removeTrailingCommas(v)).join(","));
}

export async function createFilterStream(
    source: PlayableMediaSource,
    filter?: string,
    skipTo?: number,
    signal?: AbortSignal
) {
    const taskQueue = new AsyncQueue();
    const ownedStream = "stream" in source ? source.stream : undefined;

    let input: Input;
    try {
        input = new Input({
            formats: ALL_FORMATS,
            source: createMediaSource(source)
        });
    } catch (error) {
        if (ownedStream && !ownedStream.destroyed) ownedStream.destroy();
        throw error;
    }

    let audioSink: AudioSampleSink | undefined;
    let currentFilterAPI: FilterAPI | undefined;
    let pendingAudioFilter: FilterAPI | null = null;
    let filterClosed = false;
    let resourcesClosed = false;

    const closeFilters = () => {
        if (!filterClosed) {
            filterClosed = true;
            currentFilterAPI?.close();
            currentFilterAPI = undefined;
        }

        if (pendingAudioFilter) {
            pendingAudioFilter.close();
            pendingAudioFilter = null;
        }
    };

    const closeResources = () => {
        if (resourcesClosed) return;
        resourcesClosed = true;

        closeFilters();

        // Disposing the input cancels every in-flight sink operation and closes
        // the decoder; there is no separate sink close method.
        if (!input.disposed) input.dispose();

        // Mediabunny cancels the web stream, but the producer is a Node Readable
        // owned by the extractor. Destroy it so the source cannot outlive playback.
        if (ownedStream && !ownedStream.destroyed) ownedStream.destroy();
    };

    let info: FilterStreamInfo;

    // Only the probe is cancellable here. The listener is removed before the
    // stream is returned, so a probe timeout cannot abort live playback.
    const abortProbe = () => closeResources();
    signal?.addEventListener("abort", abortProbe, { once: true });

    try {
        signal?.throwIfAborted();

        const audioTrack = await input.getPrimaryAudioTrack();
        signal?.throwIfAborted();
        if (!audioTrack) throw new Error("No usable audio tracks found for this stream.");

        audioSink = new AudioSampleSink(audioTrack);
        info = await probeInfo(audioTrack);
        signal?.throwIfAborted();

        const audioFilterString = concatFilterString(filter ?? "", OUTPUT_FORMAT);
        if (!verifyAudioFilter(audioFilterString)) {
            throw new Error("Invalid Filter string");
        }

        currentFilterAPI = FilterAPI.create(audioFilterString);
        signal?.throwIfAborted();
    } catch (error) {
        closeResources();
        if (signal?.aborted) throw signal.reason ?? new Error("Audio probe was aborted");
        throw error;
    } finally {
        signal?.removeEventListener("abort", abortProbe);
    }

    const seekToTimeStamp = skipTo ? Math.max(0, skipTo) / 1000 : undefined;
    const passThrough = new PassThrough({
        destroy(error, callback) {
            closeResources();
            callback(error);
        }
    });

    async function changeAudioFilter(filter?: string) {
        if (filterClosed) throw new FilterAPIOutdatedError();
        using _lock = await taskQueue.acquire(FILTER_CHANGE_LOCK);
        if (filterClosed) throw new FilterAPIOutdatedError();

        const audioFilter = concatFilterString(filter ?? "", OUTPUT_FORMAT);
        if (!verifyAudioFilter(audioFilter)) throw new Error("Invalid Filter string");

        pendingAudioFilter?.close();
        pendingAudioFilter = FilterAPI.create(audioFilter);
    }

    const isStale = () =>
        passThrough.destroyed ||
        passThrough.writableEnded;

    function waitForDrainOrClose(): Promise<void> {
        if (isStale()) return Promise.resolve();

        return new Promise((resolve) => {
            const finish = () => {
                passThrough.off("drain", finish);
                passThrough.off("close", finish);
                passThrough.off("error", finish);
                passThrough.off("finish", finish);
                resolve();
            };

            passThrough.once("drain", finish);
            passThrough.once("close", finish);
            passThrough.once("error", finish);
            passThrough.once("finish", finish);
        });
    }

    function settlePendingFilter() {
        if (!pendingAudioFilter) return;

        const previousFilter = currentFilterAPI;
        currentFilterAPI = pendingAudioFilter;
        pendingAudioFilter = null;
        previousFilter?.close();
    }

    ; (async () => {
        const bufferCache: Buffer[] = [];

        try {
            for await (const sample of audioSink!.samples(seekToTimeStamp)) {
                if (passThrough.destroyed) {
                    sample.close();
                    break;
                }

                settlePendingFilter();

                const frame = createAudioFrame(sample);

                try {
                    for await (const processed of currentFilterAPI!.frames(frame)) {
                        if (!processed) continue;
                        if (passThrough.destroyed) {
                            processed.free();
                            break;
                        }

                        try {
                            const buf = processed.toBuffer();
                            bufferCache.push(buf);
                        } finally {
                            processed.free();
                        }

                        if (bufferCache.length >= 3) {
                            const concatBuffer = Buffer.concat(bufferCache);
                            bufferCache.length = 0;

                            const isWritable = passThrough.write(concatBuffer);

                            if (!isWritable) {
                                await waitForDrainOrClose();
                                if (passThrough.destroyed) break;
                            }
                        }
                    }
                } finally {
                    sample.close();
                    frame.free();
                }

                if (passThrough.destroyed) break;
            }
        } catch (error) {
            if (!passThrough.destroyed) {
                passThrough.destroy(
                    error instanceof Error ?
                        error :
                        new Error("Audio filter processing failed", { cause: error })
                );
            }
            return;
        } finally {
            closeResources();
        }

        if (!passThrough.destroyed) {
            if (bufferCache.length > 0) {
                passThrough.write(Buffer.concat(bufferCache));
            }
            passThrough.end();
        }
    })();

    return {
        stream: passThrough,
        changeAudioFilter,
        info
    }
}
