// Vercel Function: GET /stats (rewritten to /api/stats). Requires header x-stats-secret.
import { statsResponse } from "../dist/http/stats.js";

export const GET = (req: Request): Promise<Response> => statsResponse(req);
