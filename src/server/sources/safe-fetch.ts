// A deliberately small HTTP client for user-supplied links. It exists because
// `fetch(userUrl)` is an SSRF primitive: it resolves the name inside the socket layer,
// follows redirects without telling us where, and buffers whatever the peer sends.
//
// The three properties this module has to hold:
//   1. Every hop is validated. A redirect is a new request to a new attacker-chosen
//      target, so the scheme, the port and the resolved address are checked again.
//   2. The address that was validated is the address that is connected to. Resolution
//      happens here, once per hop, and the winning IP is handed to the connector. A
//      second lookup would reopen the DNS rebinding window between check and connect.
//   3. The response is bounded while it streams. Content-Length is a hint from the
//      peer, never a limit.
//
// DNS and sockets arrive as injected dependencies so the rules above can be tested
// without a network.

import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type SafeFetchResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface SafeFetchConnectionRequest {
  readonly url: string;
  readonly protocol: "http:" | "https:";
  readonly hostname: string;
  /** The already validated literal address the socket must connect to. */
  readonly address: string;
  readonly family: 4 | 6;
  readonly port: number;
  readonly signal: AbortSignal;
}

export interface SafeFetchConnectionResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
}

export type SafeFetchConnector = (
  request: SafeFetchConnectionRequest,
) => Promise<SafeFetchConnectionResponse>;

export type SafeFetchFailureReason =
  | "blocked"
  | "unsupported-scheme"
  | "too-many-redirects"
  | "too-large"
  | "timeout"
  | "unavailable";

export interface SafeFetchSuccess {
  readonly ok: true;
  /** The URL of the final hop, which is what may be stored as a public URL. */
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly byteLength: number;
}

export interface SafeFetchFailure {
  readonly ok: false;
  readonly reason: SafeFetchFailureReason;
}

export type SafeFetchResult = SafeFetchSuccess | SafeFetchFailure;

export interface SafeFetchLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

export interface SafeFetchOptions extends Partial<SafeFetchLimits> {
  readonly resolve: SafeFetchResolver;
  readonly connect: SafeFetchConnector;
  readonly maxRedirects?: number;
}

/** A fetcher with its transport already bound, so callers only pass limits. */
export type SafeFetcher = (url: string, limits: SafeFetchLimits) => Promise<SafeFetchResult>;

const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;
const ALLOWED_PORTS = new Set([80, 443]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function parseIpv4(value: string): Uint8Array | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) {
    const part = parts[index]!;
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    bytes[index] = byte;
  }
  return bytes;
}

function parseIpv6(value: string): Uint8Array | null {
  if (!value.includes(":")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;

  const readGroups = (text: string): number[] | null => {
    if (text === "") return [];
    const groups: number[] = [];
    const parts = text.split(":");
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      if (part.includes(".")) {
        // A trailing dotted quad is only legal in the last position.
        if (index !== parts.length - 1) return null;
        const quad = parseIpv4(part);
        if (!quad) return null;
        groups.push((quad[0]! << 8) | quad[1]!, (quad[2]! << 8) | quad[3]!);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const head = readGroups(halves[0]!);
  const tail = halves.length === 2 ? readGroups(halves[1]!) : [];
  if (!head || !tail) return null;

  let groups: number[];
  if (halves.length === 2) {
    const gap = 8 - head.length - tail.length;
    if (gap < 1) return null;
    groups = [...head, ...new Array<number>(gap).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function isBlockedIpv4(bytes: Uint8Array): boolean {
  const [a = 0, b = 0, c = 0] = bytes;
  if (a === 0) return true; // 0.0.0.0/8, "this network"
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol / TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved and 255.255.255.255
  return false;
}

function isBlockedIpv6(bytes: Uint8Array): boolean {
  const leading = bytes.subarray(0, 12);
  const mappedPrefix = leading.every((byte, index) => (index < 10 ? byte === 0 : byte === 0xff));
  if (mappedPrefix) {
    // ::ffff:a.b.c.d — the classic way to smuggle a private v4 address past a check
    // that only understands dotted quads.
    return isBlockedIpv4(bytes.subarray(12));
  }
  // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d form.
  if (leading.every((byte) => byte === 0)) return true;

  const [a = 0, b = 0, c = 0, d = 0] = bytes;
  if ((a & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (a === 0xfe && (b & 0xc0) === 0x80) return true; // fe80::/10 link local
  if (a === 0xfe && (b & 0xc0) === 0xc0) return true; // fec0::/10 site local
  if (a === 0xff) return true; // multicast
  if (a === 0x01 && b === 0x00) return true; // 100::/64 discard
  if (a === 0x00 && b === 0x64 && c === 0xff && d === 0x9b) return true; // 64:ff9b::/96 NAT64
  if (a === 0x20 && b === 0x02) return true; // 2002::/16 6to4, embeds a v4 address
  if (a === 0x20 && b === 0x01 && c === 0x00 && d === 0x00) return true; // Teredo
  if (a === 0x20 && b === 0x01 && c === 0x0d && d === 0xb8) return true; // documentation
  return false;
}

/**
 * Fail-closed: anything that cannot be parsed as a public unicast address is blocked.
 */
export function isBlockedIpAddress(address: string): boolean {
  const value = address.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!value) return true;
  const ipv4 = parseIpv4(value);
  if (ipv4) return isBlockedIpv4(ipv4);
  const ipv6 = parseIpv6(value);
  if (ipv6) return isBlockedIpv6(ipv6);
  return true;
}

interface ValidatedHop {
  readonly url: URL;
  readonly protocol: "http:" | "https:";
  readonly port: number;
  readonly hostname: string;
  /** Present when the host is already a literal address and needs no resolution. */
  readonly literal: ResolvedAddress | null;
}

type HopCheck =
  | { readonly ok: true; readonly hop: ValidatedHop }
  | { readonly ok: false; readonly reason: SafeFetchFailureReason };

function checkHop(target: string, base?: string): HopCheck {
  let url: URL;
  try {
    url = base ? new URL(target, base) : new URL(target);
  } catch {
    return { ok: false, reason: "blocked" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "unsupported-scheme" };
  }
  // Credentials in a link are only ever used to confuse a parser or a proxy.
  if (url.username || url.password) return { ok: false, reason: "blocked" };
  if (!url.hostname) return { ok: false, reason: "blocked" };

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) return { ok: false, reason: "blocked" };

  // The URL parser has already normalised decimal, octal and hexadecimal IPv4 forms,
  // so a literal host reaches this point in dotted-quad or bracketed IPv6 shape.
  const hostname = url.hostname;
  const bracketed = hostname.startsWith("[") && hostname.endsWith("]");
  const literalText = bracketed ? hostname.slice(1, -1) : hostname;
  const isLiteral = bracketed || parseIpv4(literalText) !== null;
  if (isLiteral) {
    if (isBlockedIpAddress(literalText)) return { ok: false, reason: "blocked" };
    return {
      ok: true,
      hop: {
        url,
        protocol: url.protocol,
        port,
        hostname,
        literal: { address: literalText, family: bracketed ? 6 : 4 },
      },
    };
  }
  return { ok: true, hop: { url, protocol: url.protocol, port, hostname, literal: null } };
}

/** Validates a browser-bound URL before Chromium is allowed to request it. */
export async function isPublicWebTarget(
  target: string,
  resolve: SafeFetchResolver,
): Promise<boolean> {
  const checked = checkHop(target);
  if (!checked.ok) return false;
  if (checked.hop.literal) return true;
  try {
    const records = await resolve(checked.hop.hostname);
    return records.length > 0 && records.every((record) => !isBlockedIpAddress(record.address));
  } catch {
    return false;
  }
}

function headerValue(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

async function readBounded(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ readonly text: string; readonly byteLength: number } | "too-large" | "aborted"> {
  const decoder = new TextDecoder("utf-8");
  const parts: string[] = [];
  let byteLength = 0;
  const iterator = body[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await iterator.next();
      if (signal.aborted) return "aborted";
      if (next.done) break;
      const chunk = next.value;
      byteLength += chunk.byteLength;
      // The cut-off happens here, on the stream, so an unbounded response never lands
      // in memory whole and a lying Content-Length buys the peer nothing.
      if (byteLength > maxBytes) return "too-large";
      parts.push(decoder.decode(chunk, { stream: true }));
    }
  } finally {
    await iterator.return?.().catch(() => undefined);
  }
  parts.push(decoder.decode());
  return { text: parts.join(""), byteLength };
}

export async function safeFetch(
  target: string,
  options: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const deadline = new Promise<"timeout">((resolve) => {
    controller.signal.addEventListener("abort", () => {
      if (timedOut) resolve("timeout");
    });
  });

  const withDeadline = async <T>(work: Promise<T>): Promise<T | "timeout"> =>
    Promise.race([work, deadline]);

  try {
    let current = target;
    let base: string | undefined;

    for (let hopIndex = 0; hopIndex <= maxRedirects; hopIndex += 1) {
      // Re-validated from scratch on every hop: a redirect target is untrusted input.
      const checked = checkHop(current, base);
      if (!checked.ok) return { ok: false, reason: checked.reason };
      const hop = checked.hop;

      let pinned = hop.literal;
      if (!pinned) {
        let records: readonly ResolvedAddress[];
        try {
          const resolved = await withDeadline(options.resolve(hop.hostname));
          if (resolved === "timeout") return { ok: false, reason: "timeout" };
          records = resolved;
        } catch {
          return { ok: false, reason: "unavailable" };
        }
        if (records.length === 0) return { ok: false, reason: "blocked" };
        // Every record has to be public. Accepting a name that also answers with a
        // private address would leave the attacker one retry away from reaching it.
        if (records.some((record) => isBlockedIpAddress(record.address))) {
          return { ok: false, reason: "blocked" };
        }
        pinned = records[0]!;
      }

      let response: SafeFetchConnectionResponse;
      try {
        const connected = await withDeadline(
          options.connect({
            url: hop.url.toString(),
            protocol: hop.protocol,
            hostname: hop.hostname,
            // The validated literal, never the hostname: the socket must not resolve
            // this name a second time.
            address: pinned.address,
            family: pinned.family,
            port: hop.port,
            signal: controller.signal,
          }),
        );
        if (connected === "timeout") return { ok: false, reason: "timeout" };
        response = connected;
      } catch {
        return { ok: false, reason: timedOut ? "timeout" : "unavailable" };
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = headerValue(response.headers, "location");
        if (!location) return { ok: false, reason: "unavailable" };
        if (hopIndex === maxRedirects) return { ok: false, reason: "too-many-redirects" };
        base = hop.url.toString();
        current = location;
        continue;
      }

      if (response.status < 200 || response.status > 299) {
        return { ok: false, reason: "unavailable" };
      }

      const declaredLength = Number(headerValue(response.headers, "content-length") ?? "");
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        return { ok: false, reason: "too-large" };
      }

      let read: Awaited<ReturnType<typeof readBounded>> | "timeout";
      try {
        read = await withDeadline(readBounded(response.body, maxBytes, controller.signal));
      } catch {
        return { ok: false, reason: timedOut ? "timeout" : "unavailable" };
      }
      if (read === "timeout" || read === "aborted") return { ok: false, reason: "timeout" };
      if (read === "too-large") return { ok: false, reason: "too-large" };

      return {
        ok: true,
        url: hop.url.toString(),
        status: response.status,
        contentType: headerValue(response.headers, "content-type") ?? "",
        body: read.text,
        byteLength: read.byteLength,
      };
    }

    return { ok: false, reason: "too-many-redirects" };
  } finally {
    clearTimeout(timer);
    // Releases the connector's socket on every exit path, including the size cut-off.
    controller.abort();
  }
}

/** Resolves a name to every address it answers with, so a mixed answer can be refused. */
export function createNodeDnsResolver(): SafeFetchResolver {
  return async (hostname) => {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => ({
      address: record.address,
      family: record.family === 6 ? 6 : 4,
    }));
  };
}

/**
 * Connects to the pinned address while presenting the original hostname for SNI, the
 * Host header and certificate validation, so no part of the stack resolves the name a
 * second time. Redirects are never followed here; `safeFetch` owns that decision.
 */
export function createNodeHttpConnector(): SafeFetchConnector {
  return (request) =>
    new Promise<SafeFetchConnectionResponse>((resolve, reject) => {
      const url = new URL(request.url);
      const send = request.protocol === "https:" ? httpsRequest : httpRequest;
      const outgoing = send(
        {
          protocol: request.protocol,
          host: request.address,
          port: request.port,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          setHost: false,
          servername: request.protocol === "https:" ? request.hostname : undefined,
          signal: request.signal,
          headers: {
            host: request.hostname,
            accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
            // Identity encoding on purpose: a compressed response would only meet the
            // byte limit after it had already been expanded in memory.
            "accept-encoding": "identity",
            "user-agent": "OrincardBot/1.0 (+https://orincard.com/bot)",
          },
        },
        (incoming: IncomingMessage) => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value === undefined) continue;
            headers[name] = Array.isArray(value) ? value.join(", ") : value;
          }
          resolve({ status: incoming.statusCode ?? 0, headers, body: incoming });
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
}

export function createSafeFetcher(
  options: Omit<SafeFetchOptions, "maxBytes" | "timeoutMs">,
): SafeFetcher {
  return (url, limits) =>
    safeFetch(url, {
      ...options,
      maxBytes: limits.maxBytes,
      timeoutMs: limits.timeoutMs,
    });
}
