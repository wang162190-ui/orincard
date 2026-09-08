import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  VIDEO_AUDIO_CHUNK_SECONDS,
  VIDEO_EXECUTABLES,
  VIDEO_MAX_DURATION_SECONDS,
  VIDEO_PARSE_LIMITS,
  classifyVideoUrl,
  createVideoSourceParser,
  missingVideoExecutables,
  parseFfprobeOutput,
  type VideoParseInput,
} from "../../src/server/sources/video";
import {
  TranscriptionError,
  createOpenAiTranscriptionClient,
  cuesFromProviderResponse,
  groupCues,
  parseSubtitleCues,
  type TranscriptCue,
  type TranscriptionChunk,
  type TranscriptionClient,
} from "../../src/server/sources/transcribe";
import { parseSourceTaskPayload } from "../../src/trigger/parse-source";
import type { CommandResult, CommandRunner } from "../../src/server/sources/ocr";

const INPUT: VideoParseInput = { filePath: "/tmp/orincard-fixture.mp4" };

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    code: 0,
    stdout: Buffer.alloc(0),
    stderr: "",
    timedOut: false,
    truncated: false,
    ...overrides,
  };
}

function probe(options: {
  readonly duration: number;
  readonly audio?: boolean;
  readonly subtitles?: boolean;
  readonly title?: string;
}): CommandResult {
  const streams = [
    { index: 0, codec_type: "video" },
    ...(options.audio === false ? [] : [{ index: 1, codec_type: "audio" }]),
    ...(options.subtitles ? [{ index: 2, codec_type: "subtitle" }] : []),
  ];
  return result({
    stdout: Buffer.from(
      JSON.stringify({
        streams,
        format: {
          duration: String(options.duration),
          ...(options.title ? { tags: { title: options.title } } : {}),
        },
      }),
      "utf8",
    ),
  });
}

// Answers ffprobe and the two distinct ffmpeg invocations from a script, so the parser's
// decisions can be exercised without a real recording on disk.
function scriptedRunner(script: {
  readonly ffprobe: CommandResult;
  readonly subtitles?: CommandResult;
  readonly audio?: CommandResult | ((offset: string) => CommandResult);
}): { runner: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: CommandRunner = async (command, args) => {
    if (command === "ffprobe") {
      calls.push("ffprobe");
      return script.ffprobe;
    }
    if (command !== "ffmpeg") throw new Error(`unexpected command ${command}`);
    if (args.includes("webvtt")) {
      calls.push("ffmpeg:subtitles");
      return script.subtitles ?? result({ code: 1 });
    }
    const offset = args[args.indexOf("-ss") + 1] ?? "";
    calls.push(`ffmpeg:audio@${offset}`);
    if (typeof script.audio === "function") return script.audio(offset);
    return script.audio ?? result({ stdout: Buffer.alloc(4_096) });
  };
  return { runner, calls };
}

function recordingClient(cues: readonly TranscriptCue[] | (() => never)): {
  client: TranscriptionClient;
  chunks: TranscriptionChunk[];
} {
  const chunks: TranscriptionChunk[] = [];
  return {
    chunks,
    client: {
      async transcribe(chunk) {
        chunks.push(chunk);
        if (typeof cues === "function") return cues();
        return cues.map((cue) => ({
          ...cue,
          startSeconds: chunk.offsetSeconds + cue.startSeconds,
          endSeconds: chunk.offsetSeconds + cue.endSeconds,
        }));
      },
    },
  };
}

describe("subtitle cues", () => {
  it("reads a WebVTT file past its header and note blocks", () => {
    const cues = parseSubtitleCues(
      [
        "WEBVTT",
        "",
        "NOTE this block is not a cue",
        "",
        "1",
        "00:00:01.000 --> 00:00:03.500 align:start position:10%",
        "<v Speaker>Hello there</v>",
        "",
        "00:00:04.000 --> 00:00:06.000",
        "Second line",
      ].join("\n"),
    );
    expect(cues).toEqual([
      { startSeconds: 1, endSeconds: 3.5, text: "Hello there" },
      { startSeconds: 4, endSeconds: 6, text: "Second line" },
    ]);
  });

  it("reads SRT indices and comma decimals", () => {
    const cues = parseSubtitleCues(
      ["1", "00:00:00,500 --> 00:00:02,250", "First", "", "2", "00:01:00,000 --> 00:01:02,000", "Second"].join(
        "\n",
      ),
    );
    expect(cues).toEqual([
      { startSeconds: 0.5, endSeconds: 2.25, text: "First" },
      { startSeconds: 60, endSeconds: 62, text: "Second" },
    ]);
  });

  it("accepts the MM:SS form and skips timings it cannot read", () => {
    const cues = parseSubtitleCues(
      ["00:05.000 --> 00:07.000", "Short form", "", "not a timing", "orphan text", "", "00:09.000 --> 00:08.000", "Backwards"].join(
        "\n",
      ),
    );
    expect(cues).toEqual([{ startSeconds: 5, endSeconds: 7, text: "Short form" }]);
  });

  it("stops at the cue cap instead of reading an unbounded file", () => {
    const block = (index: number) =>
      `00:00:0${index % 10}.000 --> 00:00:0${(index % 10) + 1}.000\nline ${index}`;
    const text = Array.from({ length: 50 }, (_, index) => block(index)).join("\n\n");
    expect(parseSubtitleCues(text, { maxCues: 5, maxCharacters: 10_000 })).toHaveLength(5);
  });
});

describe("cue grouping", () => {
  const cues: TranscriptCue[] = [
    { startSeconds: 0, endSeconds: 10, text: "one" },
    { startSeconds: 10, endSeconds: 20, text: "two" },
    { startSeconds: 20, endSeconds: 40, text: "three" },
    { startSeconds: 40, endSeconds: 55, text: "four" },
  ];

  it("keeps window boundaries on real cue edges", () => {
    const grouped = groupCues(cues, {
      windowSeconds: 30,
      maxSegments: 10,
      maxCharacters: 1_000,
    });
    expect(grouped).toEqual([
      { startSeconds: 0, endSeconds: 20, text: "one two" },
      { startSeconds: 20, endSeconds: 40, text: "three" },
      { startSeconds: 40, endSeconds: 55, text: "four" },
    ]);
  });

  it("honours the segment cap", () => {
    const grouped = groupCues(cues, { windowSeconds: 1, maxSegments: 2, maxCharacters: 1_000 });
    expect(grouped).toHaveLength(2);
  });

  it("returns nothing for cues with no text", () => {
    expect(groupCues([{ startSeconds: 0, endSeconds: 1, text: "   " }])).toEqual([]);
  });
});

describe("provider responses", () => {
  const chunk = { offsetSeconds: 600, durationSeconds: 600 };

  it("shifts per-segment timings by the chunk offset", () => {
    expect(
      cuesFromProviderResponse(
        { segments: [{ start: 1.5, end: 4, text: " hello " }, { start: 4, end: 5, text: "world" }] },
        chunk,
      ),
    ).toEqual([
      { startSeconds: 601.5, endSeconds: 604, text: "hello" },
      { startSeconds: 604, endSeconds: 605, text: "world" },
    ]);
  });

  it("spans the chunk when the model returns text without timings", () => {
    expect(cuesFromProviderResponse({ text: "a whole chunk" }, chunk)).toEqual([
      { startSeconds: 600, endSeconds: 1_200, text: "a whole chunk" },
    ]);
  });

  it("returns nothing rather than an empty cue", () => {
    expect(cuesFromProviderResponse({ text: "   " }, chunk)).toEqual([]);
    expect(cuesFromProviderResponse({}, chunk)).toEqual([]);
  });
});

describe("video links", () => {
  it("refuses watch pages we have no right to read", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=abc",
      "https://youtu.be/abc",
      "https://m.bilibili.com/video/BV1",
      "https://vimeo.com/12345",
      "https://x.com/someone/status/1",
    ]) {
      expect(classifyVideoUrl(url), url).toBe("platform");
    }
  });

  it("accepts a direct https media file", () => {
    expect(classifyVideoUrl("https://files.example.com/talk.mp4")).toBe("direct");
    expect(classifyVideoUrl("https://files.example.com/a/b.M4A?token=1")).toBe("direct");
  });

  it("rejects anything else", () => {
    for (const url of [
      "http://files.example.com/talk.mp4",
      "https://files.example.com/talk",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(classifyVideoUrl(url), url).toBe("unsupported");
    }
  });
});

describe("ffprobe output", () => {
  it("reads duration, streams and the title tag", () => {
    expect(
      parseFfprobeOutput(probe({ duration: 12.5, subtitles: true, title: "Talk" }).stdout.toString("utf8")),
    ).toEqual({ durationSeconds: 12.5, hasAudio: true, hasSubtitles: true, title: "Talk" });
  });

  it("refuses output with no usable duration", () => {
    expect(parseFfprobeOutput("not json")).toBeUndefined();
    expect(parseFfprobeOutput(JSON.stringify({ streams: [], format: {} }))).toBeUndefined();
    expect(
      parseFfprobeOutput(JSON.stringify({ streams: [], format: { duration: "0" } })),
    ).toBeUndefined();
  });
});

describe("video source parser", () => {
  it("offers an upload instead of scraping a platform link", async () => {
    const { runner, calls } = scriptedRunner({ ffprobe: probe({ duration: 10 }) });
    const parser = createVideoSourceParser({ runner, transcription: null });
    const parsed = await parser.parse(
      { ...INPUT, url: "https://www.youtube.com/watch?v=abc" },
      VIDEO_PARSE_LIMITS,
    );
    expect(parsed).toMatchObject({
      ok: false,
      code: "SOURCE_BLOCKED",
      action: "upload-file",
    });
    // The refusal is decided before any process starts, so nothing is read or fetched.
    expect(calls).toEqual([]);
  });

  it("refuses a recording longer than the documented ceiling", async () => {
    const { runner } = scriptedRunner({
      ffprobe: probe({ duration: VIDEO_MAX_DURATION_SECONDS + 1 }),
    });
    const parser = createVideoSourceParser({ runner, transcription: null });
    expect(await parser.parse(INPUT, VIDEO_PARSE_LIMITS)).toMatchObject({
      ok: false,
      code: "SOURCE_TOO_LARGE",
      action: "split-input",
    });
  });

  it("refuses a file over the byte ceiling before probing it", async () => {
    const { runner, calls } = scriptedRunner({ ffprobe: probe({ duration: 10 }) });
    const parser = createVideoSourceParser({ runner, transcription: null });
    expect(
      await parser.parse(
        { ...INPUT, byteLength: VIDEO_PARSE_LIMITS.maxBytes + 1 },
        VIDEO_PARSE_LIMITS,
      ),
    ).toMatchObject({ ok: false, code: "SOURCE_TOO_LARGE" });
    expect(calls).toEqual([]);
  });

  it("reports an unreadable container as malformed", async () => {
    const { runner } = scriptedRunner({ ffprobe: result({ code: 1, stderr: "moov atom not found" }) });
    const parser = createVideoSourceParser({ runner, transcription: null });
    expect(await parser.parse(INPUT, VIDEO_PARSE_LIMITS)).toMatchObject({
      ok: false,
      code: "SOURCE_MALFORMED",
    });
  });

  it("prefers a real subtitle track and never pays to transcribe it", async () => {
    const { runner, calls } = scriptedRunner({
      ffprobe: probe({ duration: 120, subtitles: true }),
      subtitles: result({
        stdout: Buffer.from(
          "WEBVTT\n\n00:00:02.000 --> 00:00:05.000\nFrom the track\n",
          "utf8",
        ),
      }),
    });
    const { client, chunks } = recordingClient([]);
    const parser = createVideoSourceParser({
      runner,
      transcription: client,
      createId: () => "segment-1",
    });
    const parsed = await parser.parse(INPUT, VIDEO_PARSE_LIMITS);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.segments).toEqual([
      {
        segmentId: "segment-1",
        text: "From the track",
        locator: { kind: "time", startSeconds: 2, endSeconds: 5 },
      },
    ]);
    expect(parsed.metadata.durationSeconds).toBe(120);
    expect(chunks).toHaveLength(0);
    expect(calls).toEqual(["ffprobe", "ffmpeg:subtitles"]);
  });

  it("uses a supplied transcript ahead of the file's own track", async () => {
    const { runner, calls } = scriptedRunner({
      ffprobe: probe({ duration: 60, subtitles: true }),
    });
    const parser = createVideoSourceParser({
      runner,
      transcription: null,
      createId: () => "segment-1",
    });
    const parsed = await parser.parse(
      { ...INPUT, subtitleText: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nPasted\n" },
      VIDEO_PARSE_LIMITS,
    );
    expect(parsed).toMatchObject({ ok: true });
    expect(calls).toEqual(["ffprobe"]);
  });

  it("cuts audio on chunk boundaries and keeps the real offsets", async () => {
    const { runner, calls } = scriptedRunner({
      ffprobe: probe({ duration: VIDEO_AUDIO_CHUNK_SECONDS + 120 }),
      audio: result({ stdout: Buffer.alloc(8_192) }),
    });
    const { client, chunks } = recordingClient([
      { startSeconds: 0, endSeconds: 5, text: "spoken" },
    ]);
    const parser = createVideoSourceParser({
      runner,
      transcription: client,
      createId: () => "segment",
    });
    const parsed = await parser.parse(INPUT, VIDEO_PARSE_LIMITS);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(calls).toEqual([
      "ffprobe",
      "ffmpeg:audio@0.000",
      `ffmpeg:audio@${VIDEO_AUDIO_CHUNK_SECONDS.toFixed(3)}`,
    ]);
    expect(chunks.map((chunk) => chunk.offsetSeconds)).toEqual([
      0,
      VIDEO_AUDIO_CHUNK_SECONDS,
    ]);
    // The second chunk covers only what is left of the recording, not a full window.
    expect(chunks[1]?.durationSeconds).toBe(120);
    expect(parsed.segments.map((segment) => segment.locator)).toEqual([
      { kind: "time", startSeconds: 0, endSeconds: 5 },
      {
        kind: "time",
        startSeconds: VIDEO_AUDIO_CHUNK_SECONDS,
        endSeconds: VIDEO_AUDIO_CHUNK_SECONDS + 5,
      },
    ]);
  });

  it("skips a silent chunk instead of paying to be told it is empty", async () => {
    const { runner } = scriptedRunner({
      ffprobe: probe({ duration: 60 }),
      audio: result({ stdout: Buffer.alloc(200) }),
    });
    const { client, chunks } = recordingClient([]);
    const parser = createVideoSourceParser({ runner, transcription: client });
    expect(await parser.parse(INPUT, VIDEO_PARSE_LIMITS)).toMatchObject({
      ok: false,
      code: "SOURCE_NO_TEXT_LAYER",
    });
    expect(chunks).toHaveLength(0);
  });

  it("tells a file with no audio and no subtitles apart from a failure", async () => {
    const { runner } = scriptedRunner({ ffprobe: probe({ duration: 30, audio: false }) });
    const parser = createVideoSourceParser({ runner, transcription: null });
    expect(await parser.parse(INPUT, VIDEO_PARSE_LIMITS)).toMatchObject({
      ok: false,
      code: "SOURCE_NO_TEXT_LAYER",
      action: "paste-text",
    });
  });

  it("never reports a transcription that did not happen as an empty success", async () => {
    const cases = [
      { reason: "not-configured", code: "SOURCE_UNAVAILABLE", action: "paste-text" },
      { reason: "timeout", code: "SOURCE_TIMEOUT", action: "retry-later" },
      { reason: "too-large", code: "SOURCE_TOO_LARGE", action: "split-input" },
      { reason: "unavailable", code: "SOURCE_UNAVAILABLE", action: "paste-text" },
      { reason: "rejected", code: "SOURCE_UNAVAILABLE", action: "paste-text" },
    ] as const;
    for (const expected of cases) {
      const { runner } = scriptedRunner({
        ffprobe: probe({ duration: 60 }),
        audio: result({ stdout: Buffer.alloc(8_192) }),
      });
      const { client } = recordingClient(() => {
        throw new TranscriptionError(expected.reason, "no");
      });
      const parser = createVideoSourceParser({ runner, transcription: client });
      expect(await parser.parse(INPUT, VIDEO_PARSE_LIMITS), expected.reason).toMatchObject({
        ok: false,
        code: expected.code,
        action: expected.action,
      });
    }
  });

  it("reports a missing transcription capability rather than an empty video", async () => {
    const { runner } = scriptedRunner({
      ffprobe: probe({ duration: 60 }),
      audio: result({ stdout: Buffer.alloc(8_192) }),
    });
    const parser = createVideoSourceParser({ runner, transcription: null });
    expect(await parser.parse(INPUT, VIDEO_PARSE_LIMITS)).toMatchObject({
      ok: false,
      code: "SOURCE_UNAVAILABLE",
      action: "paste-text",
    });
  });
});

describe("transcription client prerequisites", () => {
  it("names the missing credential instead of returning nothing", async () => {
    const client = createOpenAiTranscriptionClient({ apiKey: "", model: "m" });
    await expect(
      client.transcribe({
        audio: new Uint8Array(8),
        filename: "a.mp3",
        mimeType: "audio/mpeg",
        offsetSeconds: 0,
        durationSeconds: 1,
      }),
    ).rejects.toMatchObject({ reason: "not-configured" });
  });

  it("names the missing model as well", async () => {
    const client = createOpenAiTranscriptionClient({ apiKey: "k", model: "" });
    await expect(
      client.transcribe({
        audio: new Uint8Array(8),
        filename: "a.mp3",
        mimeType: "audio/mpeg",
        offsetSeconds: 0,
        durationSeconds: 1,
      }),
    ).rejects.toMatchObject({ reason: "not-configured" });
  });

  it("maps a rejected credential and an overloaded service apart", async () => {
    const statuses = [
      { status: 401, reason: "not-configured" },
      { status: 429, reason: "unavailable" },
      { status: 400, reason: "rejected" },
      { status: 413, reason: "too-large" },
    ] as const;
    for (const expected of statuses) {
      const client = createOpenAiTranscriptionClient({
        apiKey: "k",
        model: "m",
        fetchImpl: (async () =>
          new Response("{}", { status: expected.status })) as typeof fetch,
      });
      await expect(
        client.transcribe({
          audio: new Uint8Array(8),
          filename: "a.mp3",
          mimeType: "audio/mpeg",
          offsetSeconds: 0,
          durationSeconds: 1,
        }),
      ).rejects.toMatchObject({ reason: expected.reason });
    }
  });
});

describe("parse-source payload", () => {
  const valid = {
    sourceId: "11111111-1111-4111-8111-111111111111",
    schemaVersion: 1 as const,
    requestId: "req-1",
  };

  it("accepts a reference-only payload", () => {
    expect(parseSourceTaskPayload(valid)).toEqual(valid);
  });

  it("refuses anything that smuggles content alongside the reference", () => {
    expect(() => parseSourceTaskPayload({ ...valid, text: "secret" })).toThrow();
    expect(() => parseSourceTaskPayload({ ...valid, schemaVersion: 2 })).toThrow();
    expect(() => parseSourceTaskPayload({ ...valid, sourceId: "nope" })).toThrow();
  });
});

// The real path: ffmpeg and ffprobe as installed, a recording produced on this machine,
// and a real transcription request. Nothing here is stubbed.
const live = process.env.ORINCARD_RUN_VIDEO_CLOUD === "1" ? describe : describe.skip;

live("video source against real tools and a real provider", () => {
  let directory = "";

  async function run(command: string, args: readonly string[]): Promise<void> {
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8").slice(0, 2_000);
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`${command} failed: ${stderr}`)),
      );
    });
  }

  beforeAll(async () => {
    const missing = await missingVideoExecutables();
    if (missing.length > 0) {
      throw new Error(
        `ORINCARD_RUN_VIDEO_CLOUD=1 requires these executables on PATH: ${missing.join(", ")}. ` +
          `Install them with "brew install ffmpeg" (expected: ${VIDEO_EXECUTABLES.join(", ")}).`,
      );
    }
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "ORINCARD_RUN_VIDEO_CLOUD=1 requires OPENAI_API_KEY, which transcribes the audio track. " +
          "Set it in .env.local; this suite must not pass without a real transcription.",
      );
    }
    if (!process.env.AI_TRANSCRIBE_MODEL) {
      throw new Error(
        "ORINCARD_RUN_VIDEO_CLOUD=1 requires AI_TRANSCRIBE_MODEL (see .env.example).",
      );
    }
    directory = await mkdtemp(join(tmpdir(), "orincard-video-fixture-"));
  }, 120_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("reads a real embedded subtitle track with its real offsets", async () => {
    const subtitlePath = join(directory, "cues.vtt");
    await writeFile(
      subtitlePath,
      "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nOrincard subtitle one\n\n00:00:04.000 --> 00:00:06.000\nOrincard subtitle two\n",
      "utf8",
    );
    const filePath = join(directory, "subtitled.mp4");
    await run("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=black:s=320x240:r=10:d=7",
      "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
      "-i", subtitlePath,
      "-map", "0:v", "-map", "1:a", "-map", "2:s",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-c:s", "mov_text",
      "-shortest", filePath,
    ]);

    const parsed = await createVideoSourceParser().parse(
      { filePath },
      VIDEO_PARSE_LIMITS,
    );
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    const text = parsed.segments.map((segment) => segment.text).join(" ");
    expect(text).toContain("Orincard subtitle one");
    expect(text).toContain("Orincard subtitle two");
    const first = parsed.segments[0]?.locator;
    expect(first).toMatchObject({ kind: "time" });
    if (first?.kind !== "time") return;
    // The offsets come out of the container, so they line up with the cue file we wrote.
    expect(first.startSeconds).toBeGreaterThanOrEqual(0.5);
    expect(first.startSeconds).toBeLessThanOrEqual(1.5);
  }, 180_000);

  it("transcribes a real audio track through the real provider", async () => {
    const spoken = join(directory, "spoken.aiff");
    // macOS speech synthesis gives the suite real words to recognise without shipping an
    // audio fixture through git. Without it there is nothing honest to assert.
    await run("say", ["-o", spoken, "Orincard turns long documents into carousels"]);
    const filePath = join(directory, "spoken.mp4");
    await run("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=black:s=320x240:r=10:d=10",
      "-i", spoken,
      "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      "-shortest", filePath,
    ]);

    const parsed = await createVideoSourceParser().parse({ filePath }, VIDEO_PARSE_LIMITS);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    const text = parsed.segments.map((segment) => segment.text).join(" ").toLowerCase();
    expect(text).toMatch(/carousel/);
    expect(parsed.metadata.durationSeconds).toBeGreaterThan(1);
    const locator = parsed.segments[0]?.locator;
    expect(locator).toMatchObject({ kind: "time", startSeconds: 0 });
  }, 300_000);

  it("refuses a file with no audio and no subtitles instead of inventing text", async () => {
    const filePath = join(directory, "silent.mp4");
    await run("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=black:s=320x240:r=10:d=3",
      "-c:v", "libx264", "-preset", "ultrafast", filePath,
    ]);
    expect(await createVideoSourceParser().parse({ filePath }, VIDEO_PARSE_LIMITS)).toMatchObject({
      ok: false,
      code: "SOURCE_NO_TEXT_LAYER",
      action: "paste-text",
    });
  }, 120_000);
});
