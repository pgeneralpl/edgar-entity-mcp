/**
 * Static guide pages in public/guides/ (served via cleanUrls, e.g. /guides/sec-edgar-mcp).
 * They must work under the strict HTML CSP from vercel.json (default-src 'none'; style-src 'unsafe-inline'):
 * inline <style> only, no scripts other than inert JSON-LD, no external stylesheets, fonts, images or frames.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type HeaderRule = { source: string; headers: { key: string; value: string }[] };
const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
  cleanUrls?: boolean;
  outputDirectory?: string;
  headers: HeaderRule[];
  rewrites: { source: string }[];
};
const cspFor = (path: string): string | undefined => {
  let csp: string | undefined;
  for (const r of vercel.headers)
    if (new RegExp(`^${r.source}$`).test(path)) for (const h of r.headers) if (h.key.toLowerCase() === "content-security-policy") csp = h.value;
  return csp;
};

const FILE = new URL("../public/guides/sec-edgar-mcp.html", import.meta.url);
const CANONICAL = "https://edgar-entity-mcp.vercel.app/guides/sec-edgar-mcp";
const STRICT_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

describe("guide: /guides/sec-edgar-mcp", () => {
  const html = existsSync(FILE) ? readFileSync(FILE, "utf8") : "";

  it("exists in the static output directory and is served without .html (cleanUrls, no rewrite)", () => {
    expect(existsSync(FILE)).toBe(true);
    expect(vercel.outputDirectory).toBe("public");
    expect(vercel.cleanUrls).toBe(true);
    for (const r of vercel.rewrites) expect(new RegExp(`^${r.source}$`).test("/guides/sec-edgar-mcp"), r.source).toBe(false);
  });

  it("gets the strict HTML CSP from vercel.json, with and without .html", () => {
    for (const p of ["/guides/sec-edgar-mcp", "/guides/sec-edgar-mcp.html"]) expect(cspFor(p), p).toBe(STRICT_CSP);
  });

  it("loads no external or blocked resources: no scripts (except JSON-LD), stylesheets, fonts, images, frames, forms or <base>", () => {
    expect(html).not.toMatch(/<(img|iframe|frame|object|embed|form|base|audio|video|source|picture|svg)\b/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i); // no inline event handlers
    expect(html).not.toMatch(/\ssrc\s*=/i);
    expect(html).not.toMatch(/@import|url\s*\(/i); // inline CSS pulls nothing in
    const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => (m[1] ?? "").trim());
    expect(scripts).toEqual(['type="application/ld+json"']);
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    expect(links).toEqual([`<link rel="canonical" href="${CANONICAL}">`]);
    expect(html.match(/<style\b[^>]*>/gi)).toEqual(["<style>"]);
  });

  it("external links open with rel=noopener; everything else is same-site or mailto", () => {
    const anchors = [...html.matchAll(/<a\b([^>]*)>/gi)].map((m) => m[1] ?? "");
    expect(anchors.length).toBeGreaterThan(5);
    for (const a of anchors) {
      const href = /href="([^"]*)"/.exec(a)?.[1];
      expect(href, a).toBeDefined();
      if (/^https?:/i.test(href!)) expect(a, href).toMatch(/\srel="[^"]*\bnoopener\b[^"]*"/);
      else expect(href, a).toMatch(/^(\/|#|mailto:)/);
    }
  });

  it("has title, description, canonical and valid JSON-LD pointing at the canonical URL", () => {
    expect(html).toMatch(/^<!doctype html>\n<html lang="en">/i);
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(html).toContain("<title>Research a US company with SEC EDGAR in Claude or Cursor (MCP)</title>");
    expect(html).toMatch(/<meta name="description" content="[^"]{50,155}">/);
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(ld).toBeDefined();
    const graph = (JSON.parse(ld!) as { "@graph": Record<string, unknown>[] })["@graph"];
    const article = graph.find((n) => n["@type"] === "TechArticle")!;
    expect(article["@id"]).toBe(`${CANONICAL}#article`);
    expect(article.mainEntityOfPage).toBe(CANONICAL);
    expect(graph.map((n) => n["@type"])).toEqual(["TechArticle", "HowTo", "SoftwareApplication", "FAQPage"]);
  });

  it("names no individual: no personal name anywhere and no JSON-LD author", () => {
    // The maintainer's first name (written as a character class so it never appears in the repo).
    expect(html).not.toMatch(/\bP[a]tryk\b/);
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    expect(ld).not.toMatch(/"author"\s*:/);
    const walk = (v: unknown): boolean =>
      Array.isArray(v) ? v.some(walk) : v !== null && typeof v === "object" ? Object.entries(v).some(([k, x]) => k === "author" || walk(x)) : false;
    expect(walk(JSON.parse(ld))).toBe(false);
    expect(html).toContain("Written by the maintainer of edgar-entity-mcp (disclosure: this guide is about the maintainer's own open-source project).");
  });

  it("is published text: one h1, no draft notes or [verify] markers, code blocks escaped", () => {
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/\[verify|DRAFT|<!--/);
    for (const [, code] of html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)) expect(code).not.toMatch(/[<>]/);
  });
});
