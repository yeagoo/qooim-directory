import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
/** The target itself is not a public HTTPS origin (or resolved to a private one). */
export class UnsafePublicTarget extends Error {}
export function privateAddress(address: string) {
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
    const value = address.toLowerCase();
    if (value === "::1" || value === "::") return true;
    if (value.startsWith("::ffff:")) return privateAddress(value.slice(7));
    return (
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("fe8") ||
      value.startsWith("fe9") ||
      value.startsWith("fea") ||
      value.startsWith("feb") ||
      value.startsWith("ff")
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
async function requestText(
  url: URL,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
) {
  const host = url.hostname.replace(/^\[|\]$/g, ""),
    addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => privateAddress(item.address)))
    throw new UnsafePublicTarget("地址解析到私网");
  const selected = addresses[0];
  return new Promise<{
    status: number;
    text: string;
    headers: Headers;
  }>((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: host,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "GET",
        servername: isIP(host) ? undefined : host,
        lookup: (_hostname, _options, callback) =>
          callback(null, selected.address, selected.family),
        headers: { host, ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          if (Buffer.byteLength(text) > maxBytes)
            req.destroy(new Error("响应超过大小限制"));
        });
        res.on("end", () => {
          const resultHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === "string") resultHeaders.set(name, value);
            else if (Array.isArray(value)) resultHeaders.set(name, value.join(", "));
          }
          resolve({ status: res.statusCode ?? 0, text, headers: resultHeaders });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("连接超时")));
    req.on("error", reject);
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
