/**
 * Runs the real usage-stats Lua scripts (src/core/stats.ts) against a real Redis server
 * (REDIS_URL, default redis://127.0.0.1:6379; CI uses a redis service container) and checks
 * their effects: EXPIREAT on every key, the client ZSET cap, the salt's TTL and idempotency,
 * and the read script's shape. Uses a minimal RESP client (no extra dependency).
 *
 *   npx tsx scripts/stats-redis-check.ts
 */
import { connect, type Socket } from "node:net";
import {
  STATS_FLUSH_SCRIPT,
  STATS_FLUSH_SCRIPT_SHA,
  STATS_READ_SCRIPT,
  STATS_SALT_SCRIPT,
  STATS_TOP_CLIENTS,
  statsExpireAt,
  saltTtlSeconds,
} from "../src/core/stats.js";

type Reply = string | number | null | Reply[] | Error;

class Resp {
  private buf = Buffer.alloc(0);
  private waiters: ((r: Reply) => void)[] = [];
  constructor(private sock: Socket) {
    sock.on("data", (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      for (;;) {
        const r = this.parse(0);
        if (!r) break;
        this.buf = this.buf.subarray(r[1]);
        this.waiters.shift()?.(r[0]);
      }
    });
  }
  private parse(i: number): [Reply, number] | undefined {
    const nl = this.buf.indexOf("\r\n", i);
    if (nl < 0) return undefined;
    const t = String.fromCharCode(this.buf[i]!);
    const line = this.buf.toString("utf8", i + 1, nl);
    const next = nl + 2;
    if (t === "+") return [line, next];
    if (t === "-") return [new Error(line), next];
    if (t === ":") return [Number(line), next];
    if (t === "$") {
      const n = Number(line);
      if (n < 0) return [null, next];
      if (this.buf.length < next + n + 2) return undefined;
      return [this.buf.toString("utf8", next, next + n), next + n + 2];
    }
    if (t === "*") {
      const n = Number(line);
      if (n < 0) return [null, next];
      const out: Reply[] = [];
      let p = next;
      for (let k = 0; k < n; k++) {
        const r = this.parse(p);
        if (!r) return undefined;
        out.push(r[0]);
        p = r[1];
      }
      return [out, p];
    }
    throw new Error(`bad RESP type ${t}`);
  }
  cmd(...args: (string | number)[]): Promise<Reply> {
    const parts = args.map(String);
    this.sock.write(`*${parts.length}\r\n` + parts.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join(""));
    return new Promise((res) => this.waiters.push(res));
  }
}

function check(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const url = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const sock = connect(Number(url.port || 6379), url.hostname);
  await new Promise<void>((res, rej) => sock.once("connect", res).once("error", rej));
  const r = new Resp(sock);
  const p = `stats-check-${Date.now()}:`;
  const day = new Date().toISOString().slice(0, 10);
  const [c, u, cl, salt] = [`${p}c`, `${p}u`, `${p}cl`, `${p}salt`];
  try {
    const exp = statsExpireAt(day);
    const members = Array.from({ length: 100 }, (_, i) => i.toString(16).padStart(16, "0"));
    const clients = Array.from({ length: 60 }, (_, i) => [`client${i}`, String(i + 1)]).flat();
    const args = [String(exp), String(STATS_TOP_CLIENTS), "100", "60", ...members, ...clients, "calls:x", "3", "ok:x", "2", "lat:50", "1"];
    check((await r.cmd("EVAL", STATS_FLUSH_SCRIPT, 3, c, u, cl, ...args)) === 1, "flush script runs (EVAL)");
    check((await r.cmd("EVALSHA", STATS_FLUSH_SCRIPT_SHA, 3, c, u, cl, String(exp), String(STATS_TOP_CLIENTS), "0", "0", "calls:x", "1")) === 1, "flush script runs (EVALSHA, cached SHA matches)");
    for (const k of [c, u, cl]) check((await r.cmd("EXPIRETIME", k)) === exp, `${k.slice(p.length)}: EXPIREAT end of day + 30 d`);
    check((await r.cmd("HGET", c, "calls:x")) === "4", "HINCRBY accumulates");
    check((await r.cmd("PFCOUNT", u)) === 100, "HLL has 100 members");
    check((await r.cmd("ZCARD", cl)) === STATS_TOP_CLIENTS, `client ZSET capped at ${STATS_TOP_CLIENTS}`);
    check(((await r.cmd("ZRANGE", cl, 0, 0)) as string[])[0] === "client10", "lowest-scored clients evicted");
    // A key that somehow lost its TTL gets it back on the next write (EXPIREAT, absolute).
    await r.cmd("PERSIST", c);
    await r.cmd("EVALSHA", STATS_FLUSH_SCRIPT_SHA, 3, c, u, cl, String(exp), String(STATS_TOP_CLIENTS), "0", "0", "init", "1");
    check((await r.cmd("EXPIRETIME", c)) === exp, "TTL self-heals on the next flush");

    const ttl = saltTtlSeconds(day, Date.now());
    check((await r.cmd("EVAL", STATS_SALT_SCRIPT, 1, salt, "a".repeat(64), ttl)) === "a".repeat(64), "salt created");
    check((await r.cmd("EVAL", STATS_SALT_SCRIPT, 1, salt, "b".repeat(64), ttl)) === "a".repeat(64), "salt is created once");
    const left = (await r.cmd("TTL", salt)) as number;
    check(left > 0 && left <= ttl && left <= 25 * 3600, `salt TTL ${left}s = end of day + 1 h - now`);

    const read = (await r.cmd("EVAL", STATS_READ_SCRIPT, 6, c, u, cl, `${p}none:c`, `${p}none:u`, `${p}none:cl`, 3)) as Reply[][];
    check(Array.isArray(read) && read.length === 2, "read script returns one entry per day");
    check(read[0]![1] === 100 && (read[0]![2] as string[]).length === 6, "read: PFCOUNT + top-3 WITHSCORES");
    check((read[1]![0] as string[]).length === 0 && read[1]![1] === 0, "read: empty day");
    console.log("ALL STATS REDIS CHECKS PASSED");
  } finally {
    await r.cmd("DEL", c, u, cl, salt);
    sock.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
