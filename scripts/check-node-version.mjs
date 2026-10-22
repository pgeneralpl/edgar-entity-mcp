/* global process, console */
// Fails when the running Node.js is older than the patched releases of the
// 2026-10-21 security release (CVE-2026-111497 Brotli decoder OOB write, TLS
// hostname checks, undici). Used by CI and release workflows.
const MIN = { 22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1] };
const [maj, min, pat] = process.versions.node.split(".").map(Number);
const floor = MIN[maj];
const ok = floor ? min > floor[1] || (min === floor[1] && pat >= floor[2]) : maj > 26;
if (!ok) {
  console.error(`Node.js ${process.version} is not a patched release. Use >= 22.23.4, >= 24.22.1 or >= 26.12.1 (20.x is end-of-life).`);
  process.exit(1);
}
console.log(`Node.js ${process.version} OK (patched)`);
