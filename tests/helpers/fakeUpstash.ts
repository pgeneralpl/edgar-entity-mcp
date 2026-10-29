import { vi } from "vitest";
import { CACHE_WRITE_SCRIPT, CACHE_WRITE_SCRIPT_SHA } from "../../src/core/cache.js";

export const FAKE = "https://fake-upstash.test";

/** Minimal Upstash REST emulator recording every command (keys, args, values). */
export function fakeUpstash() {
  const commands: unknown[][] = [];
  const kv = new Map<string, { v: string; ttl?: number }>();
  /** Billed Upstash commands: every top-level command plus every redis.call inside a script. */
  const billed = { n: 0 };
  const inner = (op: string) => {
    billed.n++;
    internal.push(op);
  };
  const internal: string[] = [];
  const getNum = (k: string) => Number(kv.get(k)?.v ?? 0);
  /** JS port of QUOTA_SCRIPT in src/core/quota.ts (same semantics and same inner commands). */
  const quotaScript = (keys: string[], args: string[]): unknown => {
    const n = keys.length;
    const [ttl, cost, gi, hard, trickle] = args.slice(0, 5).map(Number) as [number, number, number, number, number];
    const d = args.slice(5, 5 + n).map(Number);
    const lim = args.slice(5 + n, 5 + 2 * n).map(Number);
    const vals: (number | "u")[] = [];
    keys.forEach((k, i) => {
      if (d[i] !== 0) {
        inner("INCRBY");
        const prev = kv.get(k);
        const v = getNum(k) + d[i]!;
        kv.set(k, { v: String(v), ttl: prev?.ttl });
        if (v === d[i]) {
          inner("EXPIRE");
          kv.get(k)!.ttl = ttl;
        }
        vals[i] = v;
      } else vals[i] = "u";
    });
    let bad = 0;
    for (let i = 0; i < n; i++) {
      const v = vals[i]!;
      if (!(d[i]! > 0) || v === "u") continue;
      if (i + 1 === gi) {
        const own = vals[0]!;
        if (v > hard || (v > lim[i]! && own !== "u" && own > trickle)) {
          bad = i + 1;
          break;
        }
      } else if (v > lim[i]!) {
        bad = i + 1;
        break;
      }
    }
    if (bad > 0)
      keys.forEach((k, i) => {
        if (vals[i] === "u") return;
        inner("DECRBY");
        const v = getNum(k) - cost;
        kv.set(k, { v: String(v), ttl: kv.get(k)?.ttl });
        vals[i] = v;
      });
    return [bad, ...vals];
  };
  /** JS port of CACHE_WRITE_SCRIPT in src/core/cache.ts (same semantics and same inner commands). */
  const cacheWriteScript = (keys: string[], args: string[]): unknown => {
    const [ckey, vkey] = keys as [string, string];
    const [b, budget, exat, ex] = args.slice(0, 4).map(Number) as [number, number, number, number];
    inner("GET");
    const raw = kv.get(ckey);
    const cur = raw ? Number(raw.v) || 0 : 0;
    if (cur + b > budget) return [-1, cur];
    if (!raw) {
      inner("SET");
      kv.set(ckey, { v: "0", ttl: exat - Math.floor(Date.now() / 1000) });
    }
    inner("INCRBY");
    const t = cur + b;
    kv.set(ckey, { v: String(t), ttl: kv.get(ckey)!.ttl });
    inner("SET");
    kv.set(vkey, { v: args[4]!, ttl: ex });
    return [1, t];
  };
  const exec = (cmd: unknown[]): unknown => {
    commands.push(cmd);
    billed.n++;
    const [op, ...a] = cmd.map(String);
    switch ((op ?? "").toLowerCase()) {
      case "get":
        return kv.get(a[0]!)?.v ?? null;
      case "set": {
        const opt = (name: string) => a.findIndex((x, i) => i >= 2 && x.toLowerCase() === name);
        if (opt("nx") > 0 && kv.has(a[0]!)) return null;
        const exIdx = opt("ex");
        const exatIdx = opt("exat");
        const ttl = exIdx > 0 ? Number(a[exIdx + 1]) : exatIdx > 0 ? Number(a[exatIdx + 1]) - Math.floor(Date.now() / 1000) : undefined;
        kv.set(a[0]!, { v: a[1]!, ttl });
        return "OK";
      }
      case "incrby": {
        const v = getNum(a[0]!) + Number(a[1]);
        kv.set(a[0]!, { v: String(v), ttl: kv.get(a[0]!)?.ttl });
        return v;
      }
      case "expireat": {
        const e = kv.get(a[0]!);
        if (!e) return 0;
        e.ttl = Number(a[1]) - Math.floor(Date.now() / 1000);
        return 1;
      }
      case "smembers":
        return [];
      case "del": {
        let n = 0;
        for (const k of a) if (kv.delete(k)) n++;
        return n;
      }
      case "scan": {
        const mi = a.findIndex((x) => x.toLowerCase() === "match");
        const re = new RegExp("^" + (a[mi + 1] ?? "*").replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
        return ["0", [...kv.keys()].filter((k) => re.test(k))];
      }
      case "evalsha":
      case "eval": {
        const nkeys = Number(a[1]);
        const keys = a.slice(2, 2 + nkeys);
        const args = a.slice(2 + nkeys);
        if (a[0] === CACHE_WRITE_SCRIPT_SHA || a[0] === CACHE_WRITE_SCRIPT) return cacheWriteScript(keys, args);
        if (args.length === 5) {
          // @upstash/ratelimit tokenBucket: HMGET + HSET + PEXPIRE when a token is granted.
          inner("HMGET");
          inner("HSET");
          inner("PEXPIRE");
          kv.set(keys[0]!, { v: "bucket", ttl: 1 });
          return [1, Date.now() + Number(args[1]), Number(args[0])];
        }
        return quotaScript(keys, args);
      }
      default:
        return null;
    }
  };
  /** Set to an Upstash error string (e.g. the plan-limit message) to make every command fail. */
  /** `state.noscript`: EVALSHA fails with NOSCRIPT until the next EVAL loads the script (like a fresh Redis). */
  const state: { failWith?: string; full?: boolean; noscript?: boolean } = {};
  /** `state.full`: emulate a database at its data-size limit with eviction off (writes rejected, reads served). */
  const FULL_ERR = "ERR DB capacity quota exceeded";
  const WRITES = new Set(["set", "incrby", "incr", "expire", "expireat", "evalsha", "eval", "hset", "sadd"]);
  const run = (c: unknown[]): { result?: unknown; error?: string } => {
    const op = String(c[0]).toLowerCase();
    if (state.noscript && op === "evalsha") {
      commands.push(c);
      billed.n++;
      return { error: "NOSCRIPT No matching script. Please use EVAL." };
    }
    if (op === "eval") state.noscript = false;
    if (state.full && WRITES.has(String(c[0]).toLowerCase())) {
      commands.push(c);
      billed.n++;
      return { error: FULL_ERR };
    }
    return { result: exec(c) };
  };
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(FAKE)) throw new Error(`unexpected network call: ${url}`);
    const body = JSON.parse(String(init?.body ?? "[]")) as unknown[];
    const isBatch = /\/(pipeline|multi-exec)$/.test(new URL(url).pathname);
    if (state.failWith) {
      const cmds = isBatch ? (body as unknown[][]) : [body];
      cmds.forEach((c) => (commands.push(c), billed.n++));
      const err = { error: state.failWith };
      return new Response(JSON.stringify(isBatch ? cmds.map(() => err) : err), { status: isBatch ? 200 : 400, headers: { "content-type": "application/json" } });
    }
    // Like the real REST API: with `Upstash-Encoding: base64` string results come back base64-encoded.
    const b64 = new Headers(init?.headers).get("upstash-encoding") === "base64";
    const enc = (v: unknown): unknown => (typeof v === "string" && v !== "OK" ? Buffer.from(v, "utf8").toString("base64") : Array.isArray(v) ? v.map(enc) : v);
    const wrap = (r: { result?: unknown; error?: string }) => (b64 && "result" in r ? { result: enc(r.result) } : r);
    const out = isBatch ? (body as unknown[][]).map((c) => wrap(run(c))) : wrap(run(body));
    const status = !isBatch && "error" in out ? 400 : 200;
    return new Response(JSON.stringify(out), { status, headers: { "content-type": "application/json" } });
  });
  return { commands, kv, fetchStub, state, billed, internal };
}

