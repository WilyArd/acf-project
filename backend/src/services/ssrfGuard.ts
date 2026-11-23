import dns from 'node:dns/promises';
import { config } from '../config/index.js';

export type SsrfOutcome =
  | { kind: 'allowed'; addresses: string[] }
  | { kind: 'blocked'; address: string }
  | { kind: 'dns-failed'; reason: string };

export interface SsrfOptions {
  allowLocalTargets: boolean;
  timeoutMs?: number;
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

const CANONICAL_OCTET = /^(0|[1-9]\d{0,2})$/;
const HEX_GROUP = /^[0-9a-f]{1,4}$/i;

function ipv4ToOctets(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!CANONICAL_OCTET.test(part)) return null;
    const n = Number.parseInt(part, 10);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function isBlockedIpv4Bytes(a: number, b: number, c: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8 current network
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved & 255.255.255.255
  return false;
}

function isBlockedIpv4(address: string): boolean {
  const octets = ipv4ToOctets(address);
  // Fail closed on malformed/non-canonical IPv4 literals.
  if (!octets) return true;
  return isBlockedIpv4Bytes(octets[0]!, octets[1]!, octets[2]!);
}

function parseIpv6Segments(side: string, allowTrailingIpv4: boolean): number[] | null {
  if (side === '') return [];
  const rawSegments = side.split(':');
  const groups: number[] = [];

  for (let i = 0; i < rawSegments.length; i += 1) {
    const seg = rawSegments[i]!;
    if (allowTrailingIpv4 && i === rawSegments.length - 1 && seg.includes('.')) {
      const octets = ipv4ToOctets(seg);
      if (!octets) return null;
      groups.push(octets[0]! * 256 + octets[1]!, octets[2]! * 256 + octets[3]!);
      continue;
    }
    if (!HEX_GROUP.test(seg)) return null;
    groups.push(Number.parseInt(seg, 16));
  }
  return groups;
}

function expandIpv6(address: string): number[] | null {
  const zoneIdx = address.indexOf('%');
  const withoutZone = zoneIdx >= 0 ? address.slice(0, zoneIdx) : address;
  if (!withoutZone) return null;

  const halves = withoutZone.split('::');
  if (halves.length > 2) return null;

  if (halves.length === 2) {
    const head = parseIpv6Segments(halves[0]!, false);
    const tail = parseIpv6Segments(halves[1]!, true);
    if (!head || !tail) return null;
    const missing = 8 - (head.length + tail.length);
    if (missing < 1) return null;
    return [...head, ...new Array<number>(missing).fill(0), ...tail];
  }

  const full = parseIpv6Segments(withoutZone, true);
  return full && full.length === 8 ? full : null;
}

function isBlockedIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  // Fail closed on unparseable IPv6 literals.
  if (!groups) return true;

  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;

  // ::/96 — unspecified (::), loopback (::1), and deprecated IPv4-compatible addresses
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
  // ::ffff:0:0/96 — IPv4-mapped IPv6: validate the embedded IPv4 address
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isBlockedIpv4Bytes((g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff);
  }
  // 64:ff9b::/96 & 64:ff9b:1::/48 — NAT64 translators can pivot to internal IPv4
  if (g0 === 0x0064 && g1 === 0xff9b && ((g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) || g2 === 1)) {
    return true;
  }
  // 100::/64 — discard-only prefix
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // 2001::/32 — Teredo tunneling
  if (g0 === 0x2001 && g1 === 0x0000) return true;
  // 2001:2::/48 — benchmarking
  if (g0 === 0x2001 && g1 === 0x0002 && g2 === 0) return true;
  // 2001:db8::/32 — documentation
  if (g0 === 0x2001 && g1 === 0x0db8) return true;
  // 2002::/16 — 6to4 tunneling
  if (g0 === 0x2002) return true;
  // fc00::/7 — Unique Local Addresses
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 — link-local
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // fec0::/10 — deprecated site-local
  if ((g0 & 0xffc0) === 0xfec0) return true;
  // ff00::/8 — multicast
  if ((g0 & 0xff00) === 0xff00) return true;

  return false;
}

export function isBlockedAddress(address: string): boolean {
  const zoneIdx = address.indexOf('%');
  const clean = (zoneIdx >= 0 ? address.slice(0, zoneIdx) : address).trim();
  if (!clean) return true;
  if (clean.includes(':')) {
    return isBlockedIpv6(clean);
  }
  return isBlockedIpv4(clean);
}

/**
 * Resolve the target hostname with a bounded timeout and apply the ALLOW_LOCAL_TARGETS policy.
 *
 * Rejects when ANY resolved address is private/loopback/metadata/malformed. A DNS failure is
 * reported separately because the contract has no validation code for it — it becomes
 * overallStatus ERROR downstream (docs/04 §3).
 */
export async function checkTarget(url: URL, options: SsrfOptions): Promise<SsrfOutcome> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const timeoutMs = options.timeoutMs ?? config.DNS_LOOKUP_TIMEOUT_MS;
  const lookup = options.lookup ?? ((host: string) => dns.lookup(host, { all: true }));

  let addresses: Array<{ address: string; family: number }>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([
      lookup(hostname),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('DNS timeout'), { code: 'DNS_TIMEOUT' })),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    const code = (error as { code?: string }).code;
    return {
      kind: 'dns-failed',
      reason:
        code === 'DNS_TIMEOUT'
          ? 'DNS gagal: resolusi host timeout.'
          : 'DNS gagal: host target tidak dapat di-resolve.',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (addresses.length === 0) {
    return { kind: 'dns-failed', reason: 'DNS gagal: host target tidak memiliki alamat IP.' };
  }

  if (options.allowLocalTargets) {
    return { kind: 'allowed', addresses: addresses.map((entry) => entry.address) };
  }

  for (const entry of addresses) {
    if (isBlockedAddress(entry.address)) {
      return { kind: 'blocked', address: entry.address };
    }
  }

  return { kind: 'allowed', addresses: addresses.map((entry) => entry.address) };
}
