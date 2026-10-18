import { lookup as dnsLookup } from "node:dns/promises";

/**
 * SSRF defense for webhook endpoint URLs. Enforced at registration AND before
 * every delivery attempt (DNS can change between the two — DNS rebinding).
 *
 * Policy:
 * - Production: https only, no exceptions — not even localhost.
 * - Test/dev (`allowPrivate=true`): http allowed, loopback/RFC1918/etc
 *   allowed so integration tests can target local stub receivers.
 * - ALWAYS blocked, in every mode: cloud metadata addresses (169.254.169.254
 *   and the whole link-local range), credentials in the URL, unresolvable
 *   hosts, and any resolved address in a non-public range.
 * - Redirects are never followed by the dispatcher (a 3xx counts as a failed
 *   attempt); each hop would otherwise need re-validation.
 *
 * Residual risk (documented in SECURITY.md): we validate at resolve time, not
 * at TCP-connect time, so a resolver that returns different answers per query
 * inside the check-then-connect window is not fully contained. Full
 * connection-time IP pinning with TLS SNI override is the follow-up.
 */

export type BlockReason =
  | "invalid_url"
  | "credentials_in_url"
  | "http_not_allowed"
  | "unresolvable"
  | "blocked_address";

export class SsrfError extends Error {
  reason: BlockReason;
  detail: string;
  constructor(reason: BlockReason, detail: string) {
    super(`Webhook URL rejected (${reason}): ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function inCidr(ipInt: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === ((ipv4ToInt(base) ?? 0) & mask);
}

const IPV4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT shared
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // RFC1918
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmark
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];

export function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // not an IPv4 literal at all
  return IPV4_BLOCKS.some(([base, bits]) => inCidr(n, base, bits));
}

function expandIpv6(ip: string): number[] | null {
  // Returns 8 hextets or null. Handles ::ffff:1.2.3.4 mapped form.
  let v4tail: number[] | null = null;
  const v4match = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip);
  let head = ip;
  if (v4match) {
    const n = ipv4ToInt(v4match[1]!);
    if (n === null) return null;
    v4tail = [(n >>> 16) & 0xffff, n & 0xffff];
    head = ip.slice(0, ip.length - v4match[1]!.length);
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const leftPart = halves[0] ?? "";
  const rightPart = halves.length === 2 ? (halves[1] ?? "") : "";
  const left = leftPart ? leftPart.split(":") : [];
  const right = rightPart ? rightPart.split(":") : [];
  const tailSize = v4tail ? 2 : 0;
  if (halves.length === 1 && left.length + tailSize !== 8) return null;
  const zeros = 8 - tailSize - left.length - right.length;
  if (zeros < 0 || (halves.length === 1 && zeros !== 0)) return null;
  const groups = [...left, ...Array<string>(zeros).fill("0"), ...right];
  if (v4tail) groups.push(...v4tail.map((x) => x.toString(16)));
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

export function isBlockedIpv6(ip: string): boolean {
  const parsed = expandIpv6(ip.toLowerCase());
  if (!parsed) return true;
  // Indexing yields `number | undefined` under noUncheckedIndexedAccess;
  // default to -1, which matches no blocked pattern below.
  const g = (i: number): number => parsed[i] ?? -1;
  const isZero = (i: number, n: number) => parsed.slice(i, i + n).every((x) => x === 0);
  if (isZero(0, 8)) return true; // ::
  if (isZero(0, 7) && g(7) === 1) return true; // ::1 loopback
  if ((g(0) & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g(0) & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g(0) & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (isZero(0, 5) && g(5) === 0xffff) {
    // ::ffff:0:0/96 mapped — classify the embedded IPv4 address.
    const inner = `${(g(6) >>> 8) & 0xff}.${g(6) & 0xff}.${(g(7) >>> 8) & 0xff}.${g(7) & 0xff}`;
    return isBlockedIpv4(inner);
  }
  if (g(0) === 0x2001 && g(1) === 0x0db8) return true; // documentation
  if (g(0) === 0x0064 && g(1) === 0xff9b) {
    // 64:ff9b::/96 NAT64 — classify embedded IPv4 (last 32 bits).
    const inner = `${(g(6) >>> 8) & 0xff}.${g(6) & 0xff}.${(g(7) >>> 8) & 0xff}.${g(7) & 0xff}`;
    return isBlockedIpv4(inner);
  }
  if (g(0) === 0x0100) return true; // 100::/64 discard
  return false;
}

export function isBlockedIpLiteral(ip: string): boolean {
  return ip.includes(":") ? isBlockedIpv6(ip) : isBlockedIpv4(ip);
}

export interface ValidatedUrl {
  url: string;
  hostname: string;
}

/**
 * Parse + policy-check a webhook URL, then resolve its hostname and reject
 * when ANY resolved address is non-public (fail closed on DNS errors too).
 */
export async function assertUrlAllowed(rawUrl: string, opts: { allowPrivate: boolean }): Promise<ValidatedUrl> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError("invalid_url", "URL does not parse.");
  }
  if (parsed.username || parsed.password) {
    throw new SsrfError("credentials_in_url", "Userinfo in webhook URLs is not allowed.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SsrfError("invalid_url", "Only http(s) webhook URLs are supported.");
  }
  if (parsed.protocol === "http:" && !opts.allowPrivate) {
    throw new SsrfError("http_not_allowed", "Production webhook endpoints must use https.");
  }
  const hostname = parsed.hostname;
  if (!hostname) throw new SsrfError("invalid_url", "URL has no hostname.");
  let addresses: { address: string }[];
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfError("unresolvable", `Hostname does not resolve: ${hostname}`);
  }
  if (addresses.length === 0) throw new SsrfError("unresolvable", `Hostname does not resolve: ${hostname}`);
  for (const { address } of addresses) {
    if (!isBlockedIpLiteral(address)) continue; // public address: fine
    // Non-public address: permitted only in test/dev mode, and the cloud
    // metadata range is never a legitimate receiver, in any mode.
    if (!opts.allowPrivate || isMetadataAddress(address)) {
      throw new SsrfError("blocked_address", `Resolved address is not public: ${address}`);
    }
  }
  return { url: parsed.toString(), hostname };
}

function isMetadataAddress(address: string): boolean {
  if (address.includes(":")) return false; // IPv6 has no cloud metadata twin
  const n = ipv4ToInt(address);
  return n !== null && inCidr(n, "169.254.0.0", 16);
}
