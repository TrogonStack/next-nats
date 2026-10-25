import { getBlobConfig } from "./config.js";

export function blobUrl(pathname: string): string {
  const base = getBlobConfig().baseUrl.replace(/\/+$/, "");
  return `${base}/${pathname.split("/").map(encodeURIComponent).join("/")}`;
}

export function blobDownloadUrl(pathname: string): string {
  return `${blobUrl(pathname)}?download=1`;
}

export function getDownloadUrl(blobUrl: string): string {
  const url = new URL(blobUrl, "http://relative.invalid");
  url.searchParams.set("download", "1");
  return /^https?:\/\//i.test(blobUrl) ? url.toString() : `${url.pathname}${url.search}`;
}

export function resolvePathname(urlOrPathname: string): string {
  const base = getBlobConfig().baseUrl.replace(/\/+$/, "");
  let candidate = urlOrPathname;
  if (/^https?:\/\//i.test(candidate)) {
    const parsed = new URL(candidate);
    candidate = parsed.pathname;
    const basePath = /^https?:\/\//i.test(base) ? new URL(base).pathname.replace(/\/+$/, "") : base;
    if (basePath && candidate.startsWith(`${basePath}/`)) candidate = candidate.slice(basePath.length);
    return decodeURIComponent(candidate).replace(/^\/+/, "");
  }
  const withoutQuery = candidate.split("?")[0]!;
  if (base && withoutQuery.startsWith(`${base}/`)) {
    return decodeURIComponent(withoutQuery.slice(base.length)).replace(/^\/+/, "");
  }
  return withoutQuery.replace(/^\/+/, "");
}

export function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

export function isAllowedBlobUrl(url: URL): boolean {
  if (url.hostname.endsWith(".blob.vercel-storage.com")) return true;
  const base = getBlobConfig().baseUrl;
  if (!isHttpUrl(base)) return false;
  return new URL(base).origin === url.origin;
}

export function rawPathnameOfUrl(url: URL): string {
  const base = getBlobConfig().baseUrl.replace(/\/+$/, "");
  const basePath = isHttpUrl(base) ? new URL(base).pathname.replace(/\/+$/, "") : base;
  let path = url.pathname;
  if (basePath && path.startsWith(`${basePath}/`)) path = path.slice(basePath.length);
  return path.replace(/^\/+/, "");
}
