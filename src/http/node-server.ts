/**
 * Minimal local HTTP server for the Streamable HTTP endpoint (dev / self-hosting).
 * Vercel uses api/mcp.ts instead. Usage: PORT=3000 node dist/http/node-server.js
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createHttpHandler } from "./handler.js";
import { config } from "../config.js";
import { PACKAGE_NAME } from "../version.js";
import { healthResponse } from "./health.js";
import { logError } from "../core/errors.js";

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

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Host header must be one we serve (DNS-rebinding protection). */
export function hostAllowed(hostHeader: string | undefined, allowed: string[]): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase().replace(/:\d+$/, "");
  return allowed.includes(host);
}

/** Browsers send Origin on cross-site requests; only same-host or explicitly allowed origins may call us. */
export function originAllowed(origin: string | undefined, allowedHosts: string[], allowedOrigins: string[]): boolean {
  if (!origin) return true; // non-browser clients
  if (allowedOrigins.includes(origin)) return true;
  try {
    return allowedHosts.includes(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

export function startHttpServer(port = Number(process.env.PORT ?? 3000), host = process.env.HOST ?? "127.0.0.1") {
  const problem = config().startupProblem;
  if (problem) {
    process.stderr.write(`[${PACKAGE_NAME}] refusing to start: ${problem}\n`);
    process.exit(1);
  }
  const handler = createHttpHandler();
  const allowedHosts = [...LOCAL_HOSTS, ...list(process.env.ALLOWED_HOSTS)];
  const allowedOrigins = list(process.env.ALLOWED_ORIGINS);
  const trustProxy = process.env.TRUST_PROXY === "1";
  const server = createServer(async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host, allowedHosts)) {
        res.statusCode = 421;
        return void res.end("Misdirected request: host not allowed (set ALLOWED_HOSTS)");
      }
      if (!originAllowed(req.headers.origin, allowedHosts, allowedOrigins)) {
        res.statusCode = 403;
        return void res.end("Origin not allowed (set ALLOWED_ORIGINS)");
      }
      // The client IP comes from the socket unless we're explicitly behind a trusted proxy.
      if (!trustProxy) {
        delete req.headers["x-forwarded-for"];
        delete req.headers["x-vercel-forwarded-for"];
        req.headers["x-real-ip"] = req.socket.remoteAddress ?? "unknown";
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname === "/" || url.pathname === "/health") {
        return void (await sendWebResponse(res, await healthResponse(toWebRequest(req, url.origin))));
      }
      if (url.pathname !== "/mcp" && url.pathname !== "/api/mcp") {
        res.statusCode = 404;
        return void res.end("Not found");
      }
      // Body size is enforced inside the handler (MAX_BODY_BYTES) while streaming.
      await sendWebResponse(res, await handler(toWebRequest(req, url.origin)));
    } catch (e) {
      const id = logError("node-server", e);
      if (!res.headersSent) res.statusCode = 500;
      res.end(`Internal error (ref ${id})`);
    }
  });
  server.listen(port, host, () => process.stderr.write(`[${PACKAGE_NAME}] HTTP MCP endpoint on http://${host}:${port}/mcp\n`));
  return server;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("node-server.ts") || process.argv[1]?.endsWith("node-server.js");
if (isMain) startHttpServer();
