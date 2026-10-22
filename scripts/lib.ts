import { Client } from "@modelcontextprotocol/client";

export type Json = Record<string, unknown>;

export async function call(client: Client, name: string, args: Json = {}): Promise<{ data: Json; isError: boolean; chars: number; ms: number }> {
  const t0 = Date.now();
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  const text = r.content?.[0]?.text ?? "{}";
  return { data: JSON.parse(text) as Json, isError: !!r.isError, chars: text.length, ms: Date.now() - t0 };
}

let failures = 0;
export function check(cond: unknown, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
}
export function failed(): number {
  return failures;
}
export const snip = (v: unknown, n = 600) => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
};
