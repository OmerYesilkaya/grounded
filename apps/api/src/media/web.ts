import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * The web as media verification reaches it (design §6.4): the APIs that find and check media, and
 * the pages a lesson links to. Tests pass their own, so no test reaches the network.
 */
export interface WebAccess {
  /**
   * GETs JSON from an API the app trusts (Wikimedia Commons, YouTube): the status and the body
   * (null when it isn't JSON). Rejects when the host doesn't answer in time.
   */
  getJson(url: string): Promise<{ status: number; body: unknown }>;
  /**
   * Whether a page opens: the status it ends on and where, after redirects. Rejects when it can't
   * be reached: not a web address, no such host, an address inside a private network, or no answer
   * in time.
   */
  probe(url: string): Promise<Landing>;
}

/** Where a page's redirects end: its status there, and the address. */
export interface Landing {
  status: number;
  url: string;
}

/** How long an API answer may take. */
export const JSON_TIMEOUT_MS = 8000;
/** How long a page may take to answer, its redirects included. */
export const PROBE_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;

/** Wikimedia asks every client to name itself and a way to reach its operator. */
const USER_AGENT = "Grounded/1.0 (https://github.com/OmerYesilkaya/grounded)";

/** A web with nothing on it: every request fails. The default where no network may be used. */
export const offlineWeb: WebAccess = {
  getJson: () => Promise.reject(new Error("offline")),
  probe: () => Promise.reject(new Error("offline")),
};

export function createWebAccess(): WebAccess {
  return {
    async getJson(url) {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => null);
      return { status: response.status, body };
    },
    probe: (url) => probe(url, AbortSignal.timeout(PROBE_TIMEOUT_MS)),
  };
}

/**
 * Follows a page's redirects by hand, so each hop is checked like the first. HEAD first, since the
 * body isn't needed; a server that refuses HEAD is asked with GET, and the body is dropped unread.
 */
async function probe(address: string, signal: AbortSignal): Promise<Landing> {
  let url = webAddress(address);
  for (let hop = 0; ; hop++) {
    let answer = await request(url, "HEAD", signal);
    if (answer.status >= 400) answer = await request(url, "GET", signal);
    if (answer.status < 300 || answer.status >= 400 || !answer.location)
      return { status: answer.status, url: url.toString() };
    if (hop === MAX_REDIRECTS) throw new Error("too many redirects");
    url = webAddress(new URL(answer.location, url).toString());
  }
}

/** An http(s) address whose host, if written as an IP address, is a public one. */
function webAddress(address: string): URL {
  const url = new URL(address);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not a web address");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) throw new Error("a private address");
  return url;
}

function request(
  url: URL,
  method: "HEAD" | "GET",
  signal: AbortSignal,
): Promise<{ status: number; location: string | null }> {
  const send = url.protocol === "https:" ? https.request : http.request;
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        method,
        signal,
        lookup: publicLookup,
        headers: { "user-agent": USER_AGENT, accept: "text/html,*/*;q=0.8" },
      },
      (res) => {
        resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? null });
        res.destroy();
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Resolves a host name, refusing one that points inside a private network. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) {
      callback(error, "", 4);
      return;
    }
    if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) {
      callback(new Error(`${hostname} is not on the public internet`), "", 4);
      return;
    }
    if (options.all) callback(null, addresses);
    else {
      const [first] = addresses;
      callback(null, first?.address ?? "", first?.family ?? 4);
    }
  });
};

/**
 * Loopback, private, link-local, shared, multicast and reserved ranges: never fetched. An IPv4
 * address mapped into IPv6 (::ffff:127.0.0.1) is checked against the IPv4 ranges.
 */
const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  PRIVATE.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  PRIVATE.addSubnet(network, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !PRIVATE.check(address, family === 4 ? "ipv4" : "ipv6");
}
