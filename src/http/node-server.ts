/**
 * Minimal local HTTP server for the Streamable HTTP endpoint (dev / self-hosting).
 * Vercel uses api/mcp.ts instead. Usage: PORT=3000 node dist/http/node-server.js
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createHttpHandler } from "./handler.js";
import { PACKAGE_NAME } from "../version.js";
import { healthResponse } from "./health.js";

export function toWebRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const method = req.method ?? "GET";
  const hasBody = !["GET", "HEAD"].includes(method);
  return new Request(new URL(req.url ?? "/", origin), {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
    // @ts-expect-error Node's fetch requires duplex for streaming bodies
    duplex: hasBody ? "half" : undefined,
  });
}

export async function sendWebResponse(res: ServerResponse, r: Response): Promise<void> {
  res.statusCode = r.status;
  r.headers.forEach((v, k) => res.setHeader(k, v));
  if (!r.body) return void res.end();
  const reader = r.body.getReader();
  res.on("close", () => void reader.cancel().catch(() => {}));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

export function startHttpServer(port = Number(process.env.PORT ?? 3000)) {
  const handler = createHttpHandler();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname === "/" || url.pathname === "/health") {
        return void (await sendWebResponse(res, await healthResponse(toWebRequest(req, url.origin))));
      }
      if (url.pathname !== "/mcp" && url.pathname !== "/api/mcp") {
        res.statusCode = 404;
        return void res.end("Not found");
      }
      await sendWebResponse(res, await handler(toWebRequest(req, url.origin)));
    } catch (e) {
      res.statusCode = 500;
      res.end(String((e as Error).message));
    }
  });
  server.listen(port, () => process.stderr.write(`[${PACKAGE_NAME}] HTTP MCP endpoint on http://localhost:${port}/mcp\n`));
  return server;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("node-server.ts") || process.argv[1]?.endsWith("node-server.js");
if (isMain) startHttpServer();
