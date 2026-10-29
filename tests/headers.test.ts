/**
 * Security headers in vercel.json (post-launch audit, item a). Vercel matches `source` with
 * path-to-regexp; the sources used here are plain regular expressions, so `^source$` is equivalent.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

type HeaderRule = { source: string; headers: { key: string; value: string }[] };
const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as { headers: HeaderRule[]; rewrites: { source: string }[] };

function headersFor(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of vercel.headers) if (new RegExp(`^${r.source}$`).test(path)) for (const h of r.headers) out[h.key.toLowerCase()] = h.value;
  return out;
}

const HTML_PATHS = ["/", "/index", "/privacy", "/terms", "/abuse", "/index.html", "/privacy.html", "/terms.html", "/abuse.html"];
const NON_HTML = ["/mcp", "/api/mcp", "/health", "/api/health", "/.well-known/mcp/server-card.json", "/stats"];

describe("vercel.json security headers", () => {
  it("sends nosniff, DENY and a strict Referrer-Policy everywhere, including /mcp and /health", () => {
    for (const p of [...HTML_PATHS, ...NON_HTML]) {
      const h = headersFor(p);
      expect(h["x-content-type-options"], p).toBe("nosniff");
      expect(h["x-frame-options"], p).toBe("DENY");
      expect(["no-referrer", "strict-origin-when-cross-origin"], p).toContain(h["referrer-policy"]);
    }
  });

  it("applies a strict CSP to every HTML page", () => {
    for (const p of HTML_PATHS) {
      const csp = headersFor(p)["content-security-policy"];
      expect(csp, p).toBeDefined();
      const d = Object.fromEntries(csp!.split(";").map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(" ")]));
      expect(d).toEqual({ "default-src": "'none'", "style-src": "'unsafe-inline'", "frame-ancestors": "'none'", "base-uri": "'none'", "form-action": "'none'" });
    }
  });

  it("does not put a CSP (or anything else that changes behaviour) on the MCP / health endpoints", () => {
    for (const p of NON_HTML) {
      const h = headersFor(p);
      expect(h["content-security-policy"], p).toBeUndefined();
      expect(Object.keys(h).sort(), p).toEqual(["referrer-policy", "x-content-type-options", "x-frame-options"]);
    }
    expect(vercel.rewrites.map((r) => r.source)).toEqual(["/mcp", "/health", "/stats"]);
  });

  it("the HTML pages work under that CSP: no scripts, external styles, forms, frames, images or <base>", () => {
    const dir = new URL("../public/", import.meta.url);
    const pages = readdirSync(dir).filter((f) => f.endsWith(".html"));
    expect(pages.sort()).toEqual(["abuse.html", "index.html", "privacy.html", "terms.html"]);
    for (const f of pages) {
      const html = readFileSync(new URL(f, dir), "utf8");
      expect(html, f).not.toMatch(/<(script|link|form|iframe|frame|object|embed|img|base|style)\b/i);
      expect(html, f).not.toMatch(/\son[a-z]+\s*=/i); // no inline event handlers
      // Inline style attributes are used, hence style-src 'unsafe-inline' (attributes cannot be hashed without 'unsafe-hashes').
      expect(html, f).toMatch(/\sstyle="/);
    }
  });
});
