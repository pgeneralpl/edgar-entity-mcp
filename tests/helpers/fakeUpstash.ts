import { vi } from "vitest";

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
  const exec = (cmd: unknown[]): unknown => {
    commands.push(cmd);
    billed.n++;
    const [op, ...a] = cmd.map(String);
    switch ((op ?? "").toLowerCase()) {
      case "get":
        return kv.get(a[0]!)?.v ?? null;
      case "set": {
        const exIdx = a.findIndex((x) => x.toLowerCase() === "ex");
        kv.set(a[0]!, { v: a[1]!, ttl: exIdx > 0 ? Number(a[exIdx + 1]) : undefined });
        return "OK";
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
  const state: { failWith?: string } = {};
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
    const out = isBatch ? (body as unknown[][]).map((c) => ({ result: exec(c) })) : { result: exec(body) };
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { commands, kv, fetchStub, state, billed, internal };
}

