import process from 'node:process';
import type { LoaderFunction } from 'react-router';

/**
 * Startup probe for the UI SSR process.
 *
 * Mirrors `apps/api/app/api/health/health.controller.ts:checkStartup`. Fly.io
 * uses this to gate liveness/readiness checks during boot — it always
 * returns 200 once the React Router server has accepted the request, so a
 * successful response means "process is up and accepting traffic". Uptime
 * is exposed for ops dashboards / smoke scripts.
 *
 * See `docs/research/staging-cors-coep-safari-rendering-audit.md` (NEW UI
 * health routes) for the design contract.
 */
export const loader: LoaderFunction = () => {
  return Response.json({ status: 'ok', uptime: process.uptime() }, { headers: { 'Cache-Control': 'no-store' } });
};
