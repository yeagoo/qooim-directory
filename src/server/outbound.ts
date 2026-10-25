import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { ClientRequest } from "node:http";
import { isIP } from "node:net";
/** The target itself is not a public HTTPS origin (or resolved to a private one). */
export class UnsafePublicTarget extends Error {}
// Eight 16-bit words of an IPv6 address (handles "::" and a trailing dotted IPv4).
function ipv6Words(address: string): number[] | null {
  let value = address.toLowerCase().split("%")[0];
  const dotted = value.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = dotted[1].split(".").map(Number);
    value =
      value.slice(0, -dotted[1].length) +
      ((o[0] << 8) | o[1]).toString(16) +
      ":" +
      ((o[2] << 8) | o[3]).toString(16);
  }
  const [head, tail] = value.split("::");
  const left = head ? head.split(":") : [],
    right = tail ? tail.split(":") : [];
  const fill = value.includes("::") ? 8 - left.length - right.length : 0;
  const words = [...left, ...Array(fill).fill("0"), ...right].map((w) => parseInt(w, 16));
  return words.length === 8 && words.every((w) => w >= 0 && w <= 0xffff) ? words : null;
}
export function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    const [a, b, c] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(address) === 6) {
    const words = ipv6Words(address);
    if (!words) return true;
    const v4 = (high: number, low: number) =>
      `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    const zero = (n: number) => words.slice(0, n).every((w) => w === 0);
    // ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (mapped).
    if (zero(6)) return true;
    if (zero(5) && words[5] === 0xffff) return privateAddress(v4(words[6], words[7]));
    // NAT64 (64:ff9b::/96, 64:ff9b:1::/48) and 6to4 (2002::/16) embed IPv4.
    if (words[0] === 0x64 && words[1] === 0xff9b)
      return words[2] === 1 || privateAddress(v4(words[6], words[7]));
    if (words[0] === 0x2002) return privateAddress(v4(words[1], words[2]));
    return (
      (words[0] === 0x2001 && words[1] < 0x200) || // Teredo, ORCHID, benchmarking, etc.
      (words[0] === 0x2001 && words[1] === 0xdb8) || // documentation
      (words[0] === 0x100 && zero(4)) || // discard-only
      (words[0] & 0xfe00) === 0xfc00 || // unique local
      (words[0] & 0xffc0) === 0xfe80 || // link local
      (words[0] & 0xffc0) === 0xfec0 || // site local (deprecated)
      (words[0] & 0xff00) === 0xff00 // multicast
    );
  }
  return true;
}
export function publicUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new UnsafePublicTarget("仅允许公开 HTTPS 地址");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    (isIP(host) && privateAddress(host))
  )
    throw new UnsafePublicTarget("地址不是公开网络");
  return url;
}
// Resolves a host and rejects it when any address is private (used where a
// library makes the request itself, so the address cannot be pinned).
export async function assertPublicHost(
  url: URL,
  resolver: typeof lookup = lookup,
) {
  publicUrl(url.toString());
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await resolver(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => privateAddress(item.address)))
    throw new UnsafePublicTarget("地址解析到私网");
}
export async function requestText(
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
  dependencies: {
    lookup?: typeof lookup;
    request?: typeof httpsRequest;
  } = {},
) {
  const host = url.hostname.replace(/^\[|\]$/g, ""),
    addresses = await (dependencies.lookup ?? lookup)(host, {
      all: true,
      verbatim: true,
    });
  if (!addresses.length || addresses.some((item) => privateAddress(item.address)))
    throw new UnsafePublicTarget("地址解析到私网");
  const selected = addresses[0];
  const request = dependencies.request ?? httpsRequest;
  return new Promise<{
    status: number;
    text: string;
    headers: Headers;
  }>((resolve, reject) => {
    let req: ClientRequest;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
      req?.destroy();
    };
    req = request(
      {
        hostname: host,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "GET",
        servername: isIP(host) ? undefined : host,
        lookup: (_hostname, _options, callback) =>
          callback(null, selected.address, selected.family),
        headers: { host: url.host, ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > maxBytes) {
            fail(new Error("响应超过大小限制"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          const resultHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === "string") resultHeaders.set(name, value);
            else if (Array.isArray(value)) resultHeaders.set(name, value.join(", "));
          }
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
            headers: resultHeaders,
          });
        });
        res.on("error", (error: Error) => fail(error));
      },
    );
    timer = setTimeout(() => fail(new Error("请求超时")), timeoutMs);
    timer.unref?.();
    req.on("timeout", () => fail(new Error("连接超时")));
    req.on("error", (error: Error) => fail(error));
    req.end();
  });
}
export async function fetchPublicText(
  value: string,
  options: {
    etag?: string | null;
    timeoutMs?: number;
    maxBytes?: number;
    redirects?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<{ notModified: boolean; text: string; etag: string | null }> {
  let url = publicUrl(value);
  let redirects = options.redirects ?? 0;
  for (;;) {
    const response = await requestText(
      url,
      {
        "user-agent": "QooIM-Directory-Collector/1",
        accept: "application/rss+xml, application/atom+xml, application/json, text/xml, */*",
        ...options.headers,
        ...(options.etag ? { "if-none-match": options.etag } : {}),
      },
      options.timeoutMs ?? 10000,
      options.maxBytes ?? 2 * 1024 * 1024,
    );
    if (response.status === 304)
      return { notModified: true, text: "", etag: options.etag ?? null };
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects >= 2) throw new Error("重定向过多");
      url = publicUrl(new URL(location, url).toString());
      redirects++;
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      throw new Error("HTTP " + response.status);
    return {
      notModified: false,
      text: response.text,
      etag: response.headers.get("etag"),
    };
  }
}
