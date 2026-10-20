// Vercel Function (Node.js runtime, Web-standard handler).
// `npm run build` runs first (vercel.json buildCommand), so we import the compiled core.
import { createHttpHandler } from "../dist/http/handler.js";

const handler = createHttpHandler();

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
