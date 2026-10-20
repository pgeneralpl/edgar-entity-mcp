// Vercel Function: GET /health (rewritten to /api/health).
import { healthResponse } from "../dist/http/health.js";

export const GET = (): Response => healthResponse();
