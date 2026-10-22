/**
 * Oldest patched release per supported Node.js line (security release of 2026-10-21, incl.
 * CVE-2026-111497, a Brotli decoder out-of-bounds write reachable through fetch() responses).
 * 20.x is end-of-life and never patched. Odd lines are unsupported.
 */
export const PATCHED_NODE: Record<number, [number, number]> = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
export const PATCHED_NODE_TEXT = ">= 22.23.4 (22.x), >= 24.22.1 (24.x) or >= 26.12.1 (26.x)";

export function isPatchedNode(version: string = process.versions.node): boolean {
  const [maj = 0, min = 0, pat = 0] = version.replace(/^v/, "").split(".").map(Number);
  const floor = PATCHED_NODE[maj];
  if (!floor) return maj > 26;
  return min > floor[0] || (min === floor[0] && pat >= floor[1]);
}
