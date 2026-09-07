import { describe, expect, it, vi } from "vitest";
import {
  createSafeFetcher,
  isBlockedIpAddress,
  safeFetch,
  type ResolvedAddress,
  type SafeFetchConnectionRequest,
  type SafeFetchConnectionResponse,
} from "../../src/server/sources/safe-fetch";

function address(value: string, family: 4 | 6 = 4): ResolvedAddress {
  return { address: value, family };
}

async function* chunks(text: string, size = 64): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

function respond(
  text: string,
  overrides: {
    readonly status?: number;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): SafeFetchConnectionResponse {
  return {
    status: overrides.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8", ...overrides.headers },
    body: chunks(text),
  };
}

function resolverFor(map: Readonly<Record<string, readonly ResolvedAddress[]>>) {
  return vi.fn(async (hostname: string) => {
    const found = map[hostname];
    if (!found) throw new Error(`unexpected hostname ${hostname}`);
    return found;
  });
}

const PUBLIC_HOST = { "docs.example.com": [address("93.184.216.34")] };

describe("T039 address classification", () => {
  it("blocks every IPv4 range that can reach infrastructure instead of the public web", () => {
    for (const value of [
      "10.0.0.1",
      "10.255.255.254",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "127.0.0.1",
      "127.1.2.3",
      "169.254.169.254", // the cloud instance metadata endpoint
      "169.254.170.2",
      "0.0.0.0",
      "0.1.2.3",
      "100.64.0.1", // CGNAT
      "100.127.255.255",
      "192.0.0.1",
      "192.0.2.5",
      "198.18.0.1",
      "255.255.255.255",
      "224.0.0.1",
    ]) {
      expect(isBlockedIpAddress(value), value).toBe(true);
    }
  });

  it("allows ordinary public IPv4 addresses next to the ranges it blocks", () => {
    for (const value of [
      "93.184.216.34",
      "8.8.8.8",
      "1.1.1.1",
      "172.15.0.1", // just below the private /12
      "172.32.0.1", // just above the private /12
      "100.63.255.255", // just below CGNAT
      "100.128.0.1", // just above CGNAT
      "11.0.0.1",
      "223.255.255.254",
    ]) {
      expect(isBlockedIpAddress(value), value).toBe(false);
    }
  });

  it("blocks loopback, unique-local, link-local and multicast IPv6", () => {
    for (const value of [
      "::",
      "::1",
      "0:0:0:0:0:0:0:1",
      "fc00::1",
      "fd12:3456:789a::1", // ULA, the range a private network actually uses
      "fe80::1",
      "fe80::a00:27ff:fe4e:66a1",
      "fec0::1",
      "ff02::1",
      "2001:db8::1",
      "2002:7f00:1::", // 6to4, embeds 127.0.0.0
      "64:ff9b::7f00:1", // NAT64, embeds 127.0.0.1
      "not-an-address",
      "",
    ]) {
      expect(isBlockedIpAddress(value), value).toBe(true);
    }
  });

  it("blocks IPv4-mapped IPv6 written to smuggle a private address past a v4-only check", () => {
    for (const value of [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
      "::ffff:10.0.0.1",
      "::ffff:192.168.0.1",
      "::127.0.0.1", // deprecated IPv4-compatible form
    ]) {
      expect(isBlockedIpAddress(value), value).toBe(true);
    }
    expect(isBlockedIpAddress("::ffff:93.184.216.34")).toBe(false);
    expect(isBlockedIpAddress("2606:4700::1111")).toBe(false);
  });
});

describe("T039 safe fetch scheme and target validation", () => {
  const options = () => ({
    resolve: resolverFor(PUBLIC_HOST),
    connect: vi.fn(async () => respond("<p>hello</p>")),
  });

  it("refuses every scheme that is not http or https before touching DNS", async () => {
    for (const target of [
      "file:///etc/passwd",
      "gopher://127.0.0.1:11211/_stats",
      "data:text/html,<p>hi</p>",
      "ftp://example.com/pub",
      "javascript:alert(1)",
      "blob:https://example.com/1234",
    ]) {
      const current = options();
      const result = await safeFetch(target, current);
      expect(result.ok, target).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("unsupported-scheme");
      expect(current.resolve).not.toHaveBeenCalled();
      expect(current.connect).not.toHaveBeenCalled();
    }
  });

  it("refuses a malformed target and a target carrying embedded credentials", async () => {
    for (const target of ["not a url", "http://", "https://user:secret@docs.example.com/a"]) {
      const current = options();
      const result = await safeFetch(target, current);
      expect(result.ok, target).toBe(false);
      expect(current.connect).not.toHaveBeenCalled();
    }
  });

  it("refuses ports outside the two the public web is served on", async () => {
    const current = options();
    const result = await safeFetch("http://docs.example.com:11211/", current);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("blocked");
    expect(current.connect).not.toHaveBeenCalled();

    const allowed = options();
    await expect(safeFetch("https://docs.example.com:443/a", allowed)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("blocks a literal private host without asking the resolver at all", async () => {
    for (const target of [
      "http://127.0.0.1/admin",
      "http://10.0.0.5/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fd00::1]/",
      "http://2130706433/", // decimal 127.0.0.1, normalised by the URL parser
      "http://0x7f.0.0.1/", // hexadecimal 127.0.0.1
    ]) {
      const current = options();
      const result = await safeFetch(target, current);
      expect(result.ok, target).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("blocked");
      expect(current.resolve).not.toHaveBeenCalled();
      expect(current.connect).not.toHaveBeenCalled();
    }
  });
});

describe("T039 DNS rebinding", () => {
  it("blocks a hostname whose resolution reaches a private address", async () => {
    const resolve = resolverFor({ "internal.example.com": [address("10.1.2.3")] });
    const connect = vi.fn(async () => respond("<p>secret</p>"));
    const result = await safeFetch("https://internal.example.com/", { resolve, connect });
    expect(result).toEqual({ ok: false, reason: "blocked" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("blocks a hostname where only one of several records is private", async () => {
    const resolve = resolverFor({
      "split.example.com": [address("93.184.216.34"), address("192.168.0.9")],
    });
    const connect = vi.fn(async () => respond("<p>secret</p>"));
    const result = await safeFetch("https://split.example.com/", { resolve, connect });
    expect(result).toEqual({ ok: false, reason: "blocked" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("connects to the address it validated instead of resolving the name a second time", async () => {
    // A rebinding resolver: public on the first lookup, private on every later one. A
    // fetcher that validates a name and then hands the name to the socket layer would
    // connect to 169.254.169.254 here.
    let lookups = 0;
    const resolve = vi.fn(async () => {
      lookups += 1;
      return lookups === 1 ? [address("93.184.216.34")] : [address("169.254.169.254")];
    });
    const seen: SafeFetchConnectionRequest[] = [];
    const connect = vi.fn(async (request: SafeFetchConnectionRequest) => {
      seen.push(request);
      return respond("<p>public page</p>");
    });

    const result = await safeFetch("https://rebind.example.com/a", { resolve, connect });

    expect(result.ok).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.address).toBe("93.184.216.34");
    expect(seen[0]?.hostname).toBe("rebind.example.com");
    expect(seen[0]?.port).toBe(443);
  });
});

describe("T039 redirects", () => {
  it("revalidates every hop instead of only the first URL", async () => {
    const resolve = resolverFor({
      "docs.example.com": [address("93.184.216.34")],
      "internal.example.com": [address("169.254.169.254")],
    });
    const connect = vi.fn(async () =>
      respond("", { status: 302, headers: { location: "https://internal.example.com/creds" } }),
    );

    const result = await safeFetch("https://docs.example.com/start", { resolve, connect });

    expect(result).toEqual({ ok: false, reason: "blocked" });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("blocks a redirect that changes scheme to something unfetchable", async () => {
    const resolve = resolverFor(PUBLIC_HOST);
    const connect = vi.fn(async () =>
      respond("", { status: 301, headers: { location: "file:///etc/passwd" } }),
    );
    const result = await safeFetch("https://docs.example.com/start", { resolve, connect });
    expect(result).toEqual({ ok: false, reason: "unsupported-scheme" });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("follows a relative redirect and reports the final URL it actually read", async () => {
    const resolve = resolverFor({
      "docs.example.com": [address("93.184.216.34")],
      "cdn.example.com": [address("93.184.216.35")],
    });
    const connect = vi.fn(async (request: SafeFetchConnectionRequest) => {
      if (request.url === "https://docs.example.com/start") {
        return respond("", { status: 302, headers: { location: "/moved" } });
      }
      if (request.url === "https://docs.example.com/moved") {
        return respond("", { status: 307, headers: { location: "https://cdn.example.com/final" } });
      }
      return respond("<p>Final body.</p>");
    });

    const result = await safeFetch("https://docs.example.com/start", { resolve, connect });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toBe("https://cdn.example.com/final");
    expect(result.body).toContain("Final body.");
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("stops a redirect chain at the hop limit instead of looping", async () => {
    const resolve = resolverFor(PUBLIC_HOST);
    let hop = 0;
    const connect = vi.fn(async () => {
      hop += 1;
      return respond("", {
        status: 302,
        headers: { location: `https://docs.example.com/hop-${hop}` },
      });
    });

    const result = await safeFetch("https://docs.example.com/start", {
      resolve,
      connect,
      maxRedirects: 3,
    });

    expect(result).toEqual({ ok: false, reason: "too-many-redirects" });
    expect(connect).toHaveBeenCalledTimes(4);
  });

  it("treats a redirect without a target and an error status as unavailable", async () => {
    const resolve = resolverFor(PUBLIC_HOST);
    for (const status of [302, 404, 500]) {
      const result = await safeFetch("https://docs.example.com/start", {
        resolve,
        connect: async () => respond("", { status }),
      });
      expect(result, String(status)).toEqual({ ok: false, reason: "unavailable" });
    }
  });
});

describe("T039 response size and time limits", () => {
  it("aborts a lying Content-Length while streaming instead of buffering the response", async () => {
    const resolve = resolverFor(PUBLIC_HOST);
    let yielded = 0;
    let signal: AbortSignal | undefined;
    const connect = async (request: SafeFetchConnectionRequest) => {
      signal = request.signal;
      return {
        status: 200,
        headers: { "content-type": "text/html", "content-length": "12" },
        body: (async function* stream() {
          for (let index = 0; index < 10_000; index += 1) {
            yielded += 1;
            yield new Uint8Array(1_024);
          }
        })(),
      };
    };

    const result = await safeFetch("https://docs.example.com/huge", {
      resolve,
      connect,
      maxBytes: 4_096,
    });

    expect(result).toEqual({ ok: false, reason: "too-large" });
    // Streaming cut-off, not a length check after the fact.
    expect(yielded).toBeLessThan(10);
    expect(signal?.aborted).toBe(true);
  });

  it("rejects an honest oversized Content-Length before reading a single chunk", async () => {
    const resolve = resolverFor(PUBLIC_HOST);
    let started = false;
    const connect = async () => ({
      status: 200,
      headers: { "content-type": "text/html", "content-length": "50000000" },
      body: (async function* stream() {
        started = true;
        yield new Uint8Array(1_024);
      })(),
    });

    const result = await safeFetch("https://docs.example.com/huge", {
      resolve,
      connect,
      maxBytes: 4_096,
    });

    expect(result).toEqual({ ok: false, reason: "too-large" });
    expect(started).toBe(false);
  });

  it("times out a connection that never answers and aborts it", async () => {
    const resolve = resolverFor(PUBLIC_HOST);
    let signal: AbortSignal | undefined;
    const connect = (request: SafeFetchConnectionRequest) =>
      new Promise<SafeFetchConnectionResponse>((_resolve, reject) => {
        signal = request.signal;
        request.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });

    const result = await safeFetch("https://docs.example.com/slow", {
      resolve,
      connect,
      timeoutMs: 20,
    });

    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(signal?.aborted).toBe(true);
  });

  it("times out a body that trickles past the deadline", async () => {
    const resolve = resolverFor(PUBLIC_HOST);
    const connect = async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: (async function* stream() {
        for (let index = 0; index < 100; index += 1) {
          await new Promise((done) => setTimeout(done, 20));
          yield new TextEncoder().encode("<p>slow</p>");
        }
      })(),
    });

    const result = await safeFetch("https://docs.example.com/trickle", {
      resolve,
      connect,
      timeoutMs: 30,
    });

    expect(result).toEqual({ ok: false, reason: "timeout" });
  });

  it("reports a transport failure as unavailable rather than throwing", async () => {
    const resolve = resolverFor(PUBLIC_HOST);
    const result = await safeFetch("https://docs.example.com/", {
      resolve,
      connect: async () => {
        throw new Error("ECONNREFUSED 93.184.216.34:443");
      },
    });
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("reports a resolver failure as unavailable rather than throwing", async () => {
    const result = await safeFetch("https://missing.example.com/", {
      resolve: async () => {
        throw new Error("ENOTFOUND missing.example.com");
      },
      connect: async () => respond("<p>never</p>"),
    });
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("blocks a hostname that resolves to nothing at all", async () => {
    const result = await safeFetch("https://empty.example.com/", {
      resolve: async () => [],
      connect: async () => respond("<p>never</p>"),
    });
    expect(result).toEqual({ ok: false, reason: "blocked" });
  });

  it("binds limits once through createSafeFetcher and applies them per call", async () => {
    const resolve = resolverFor(PUBLIC_HOST);
    const fetcher = createSafeFetcher({
      resolve,
      connect: async () => respond("<p>Bound.</p>"),
    });
    const result = await fetcher("https://docs.example.com/a", {
      maxBytes: 1_000,
      timeoutMs: 1_000,
    });
    expect(result.ok).toBe(true);
  });
});
