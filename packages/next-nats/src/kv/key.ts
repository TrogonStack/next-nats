declare const brand: unique symbol;

export type KvKey = string & { readonly [brand]: "KvKey" };

const SAFE = /[A-Za-z0-9_\-/]/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hex(byte: number): string {
  return `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

export function encodeKey(key: string): KvKey {
  if (key.length === 0) throw new TypeError("KV key must not be empty");
  const chars = Array.from(key);
  let out = "";
  chars.forEach((ch, i) => {
    if (SAFE.test(ch)) {
      out += ch;
    } else if (ch === ":" && i > 0 && i < chars.length - 1 && chars[i - 1] !== ":" && chars[i + 1] !== ":") {
      out += ".";
    } else {
      for (const byte of encoder.encode(ch)) out += hex(byte);
    }
  });
  return out as KvKey;
}

export function decodeKey(encoded: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    const ch = encoded[i]!;
    if (ch === "=") {
      bytes.push(Number.parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (ch === ".") {
      bytes.push(0x3a);
    } else {
      bytes.push(ch.charCodeAt(0));
    }
  }
  return decoder.decode(new Uint8Array(bytes));
}

export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") re += "[\\s\\S]*";
    else if (ch === "?") re += "[\\s\\S]";
    else if (ch === "\\" && i + 1 < pattern.length) re += escapeRe(pattern[++i]!);
    else if (ch === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end === -1) {
        re += "\\[";
        continue;
      }
      let body = pattern.slice(i + 1, end);
      const negate = body.startsWith("^");
      if (negate) body = body.slice(1);
      re += `[${negate ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`;
      i = end;
    } else re += escapeRe(ch);
  }
  return new RegExp(`^${re}$`, "u");
}

function escapeRe(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
