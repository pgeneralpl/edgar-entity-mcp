/** MCP SEC Security review of PR #2: M-a, M-b, M-c, L-a, H-a (slots, reserved SEC share). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resetConfig } from "../src/config.js";
import { looksLikeOrganization, STATE_SOURCES } from "../src/states/registry.js";
import { applyPrivacy, loadSuppression, normEntityId, parseSuppressions, resetSuppressionCache } from "../src/states/suppression.js";
import { clientIp } from "../src/core/apiKeys.js";
import { ClientSlots, RateLimiter } from "../src/core/rateLimiter.js";
import { runWithContext, callerIsTrusted } from "../src/core/context.js";
import { lookupBusinessEntity } from "../src/tools.js";
import { resetLimiters } from "../src/core/http.js";
import { setCache, MemoryCache } from "../src/core/cache.js";
import { FAKE, fakeUpstash } from "./helpers/fakeUpstash.js";

const none = { entities: new Set<string>(), agentNames: new Set<string>() };
beforeEach(() => {
  resetConfig(loadConfig({ SEC_USER_AGENT: "Test Co test@example.org" }));
  resetSuppressionCache(none);
  setCache(new MemoryCache(), new MemoryCache());
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetConfig(undefined);
  resetSuppressionCache(undefined);
  setCache(undefined);
  resetLimiters();
});

describe("M-a: org-vs-individual defaults to individual", () => {
  it.each(["JOHN CHURCH", "JUDE LAW", "DAVID CO", "JOHN SMITH PA", "JOHN SMITH PC", "Jane Doe", "MARY BANKS", "TRUST ME", "CORPORATE JOE"])("%s → individual", (n) => {
    expect(looksLikeOrganization(n)).toBe(false);
  });
  it.each(["CORPORATION SERVICE COMPANY", "CT CORPORATION SYSTEM", "C T Corporation System", "ACME, INC.", "SMITH & CO", "Smith and Co.", "Foo Holdings LLC", "Bar L.L.C.", "Baz Ltd", "Qux LLP", "First National Bank", "Cogency Global Inc."])(
    "%s → organization",
    (n) => {
      expect(looksLikeOrganization(n)).toBe(true);
    },
  );
  it("Colorado/Oregon 'organization name' columns holding a person's name are treated as individuals", () => {
    const r = STATE_SOURCES.CO!.normalize([{ entityid: "1", entityname: "Acme LLC", agentorganizationname: "JOHN CHURCH" }], (id) => id);
    expect(r[0]!.registered_agent!.kind).toBe("individual");
  });
});

describe("M-b: agent details for keyed callers only; related addresses withheld", () => {
  const co = (agent: Record<string, string>) =>
    STATE_SOURCES.CO!.normalize([{ entityid: "1", entityname: "Acme LLC", principaladdress1: "9 Home Rd", principalcity: "Denver", ...agent }], (id) => `u/${id}`);
  it("withholds principal/mailing addresses when the agent is an individual", () => {
    const out = applyPrivacy(co({ agentfirstname: "Jane", agentlastname: "Doe" }), { includeAgentDetails: false, suppression: none });
    expect(out[0]!.principal_address).toBeUndefined();
    expect(out[0]!.addresses_withheld).toBe(true);
    expect(JSON.stringify(out)).not.toContain("Home Rd");
    const org = applyPrivacy(co({ agentorganizationname: "CORPORATION SERVICE COMPANY" }), { includeAgentDetails: false, suppression: none });
    expect(org[0]!.principal_address).toContain("Home Rd");
  });
  it("anonymous callers cannot unlock include_agent_details; keyed callers can", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ entityid: "1", entityname: "Acme LLC", principaladdress1: "9 Home Rd", agentfirstname: "Jane", agentlastname: "Doe" }]), { headers: { "content-type": "application/json" } })),
    );
    const args = { name: "Acme", states: ["CO"], match: "contains", limit: 5, active_only: false, include_agent_details: true };
    const anon = await runWithContext({ principal: { id: "ip:x", tier: "anon" }, transport: "http" }, async () => {
      expect(callerIsTrusted()).toBe(false);
      return lookupBusinessEntity.run(args as never);
    });
    expect(JSON.stringify(anon)).not.toMatch(/Jane|Home Rd/);
    expect(String((anon as { privacy?: string }).privacy)).toMatch(/requires an API key/);
    const keyed = await runWithContext({ principal: { id: "key:x", tier: "key" }, transport: "http" }, async () => lookupBusinessEntity.run(args as never));
    expect(JSON.stringify(keyed)).toContain("Jane");
  });
});

describe("M-c: suppression matching and cold-start refusal", () => {
  it("normalizes entity ids", () => {
    expect(normEntityId("ny", "000123-a")).toBe(normEntityId("NY", "123A"));
    const sup = parseSuppressions(["entity:NY:0001234"]);
    const ny = STATE_SOURCES.NY!.normalize([{ dos_id: "1234", current_entity_name: "X Corp" }], (id) => id);
    expect(applyPrivacy(ny, { includeAgentDetails: true, suppression: sup })[0]!.redacted).toBeDefined();
  });
  it("matches suppressed names in entity name, NY location_name and addresses", () => {
    const sup = parseSuppressions(["agent:Jane Doe"]);
    const ny = STATE_SOURCES.NY!.normalize(
      [
        { dos_id: "1", current_entity_name: "JANE DOE CONSULTING LLC" },
        { dos_id: "2", current_entity_name: "Other LLC", location_name: "Jane Doe", location_address_1: "1 Main" },
        { dos_id: "3", current_entity_name: "Third LLC", dos_process_name: "THE LLC", dos_process_address_1: "c/o Jane Doe, 5 Elm" },
        { dos_id: "4", current_entity_name: "Janet Doerr LLC" },
      ],
      (id) => id,
    );
    const out = applyPrivacy(ny, { includeAgentDetails: true, suppression: sup });
    expect(out[0]!.redacted).toBeDefined();
    expect(out[1]!.redacted).toBeDefined();
    expect(JSON.stringify(out[2])).not.toContain("Elm");
    expect(out[3]!.redacted).toBeUndefined(); // whole-word match only
  });
  it("refuses state lookups on a cold start when Redis fails (no upstream request)", async () => {
    const f = fakeUpstash();
    f.state.failWith = "ERR connection refused";
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: RequestInfo | URL, i?: RequestInit) => (calls.push(String(u)), f.fetchStub(u, i))));
    resetConfig(loadConfig({ SEC_USER_AGENT: "Test Co test@example.org", IP_HASH_SALT: "x".repeat(40), UPSTASH_REDIS_REST_URL: FAKE, UPSTASH_REDIS_REST_TOKEN: "t" }));
    resetSuppressionCache(undefined);
    await expect(loadSuppression()).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    await expect(lookupBusinessEntity.run({ name: "Acme", states: ["CO"], match: "contains", limit: 5, active_only: false, include_agent_details: false } as never)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(calls.every((u) => u.startsWith(FAKE))).toBe(true); // never reached the state registry
  });
});

describe("L-a: client IP header order", () => {
  const req = (h: Record<string, string>) => new Request("https://x/", { headers: h });
  it("prefers x-vercel-forwarded-for, then XFF first hop, then x-real-ip", () => {
    expect(clientIp(req({ "x-vercel-forwarded-for": "1.1.1.1", "x-forwarded-for": "2.2.2.2", "x-real-ip": "3.3.3.3" }))).toBe("1.1.1.1");
    expect(clientIp(req({ "x-forwarded-for": "2.2.2.2, 10.0.0.1", "x-real-ip": "3.3.3.3" }))).toBe("2.2.2.2");
    expect(clientIp(req({ "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
  });
});

describe("H-a: per-client upstream concurrency and reserved SEC share for keyed callers", () => {
  it("caps concurrent upstream fetches per client", async () => {
    const slots = new ClientSlots(2, 1000);
    let peak = 0;
    let active = 0;
    const job = () =>
      slots.run("c1", async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
      });
    await Promise.all([job(), job(), job(), job(), job(), slots.run("c2", async () => undefined)]);
    expect(peak).toBe(2);
    expect(slots.activeFor("c1")).toBe(0);
  });
  it("times out queued work with RATE_LIMITED", async () => {
    const slots = new ClientSlots(1, 30);
    const long = slots.run("c", () => new Promise((r) => setTimeout(r, 200)));
    await expect(slots.run("c", async () => 1)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await long;
  });
  it("keyed callers draw from the reserved bucket first; anonymous callers never touch it", async () => {
    const used: string[] = [];
    const reserved = { take: async () => (used.push("reserved"), { ok: false as const, retryAfterMs: 5 }) };
    const shared = { take: async () => (used.push("shared"), { ok: true as const }) };
    const rl = new RateLimiter(1000, { shared, reserved });
    await rl.acquire("key");
    expect(used).toEqual(["reserved", "shared"]);
    used.length = 0;
    await rl.acquire("anon");
    expect(used).toEqual(["shared"]);
  });
});
