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
 * Used so the platform only marks the process ready after it accepts traffic.
 */
export const loader: LoaderFunction = () => {
  return Response.json({ status: 'ok', uptime: process.uptime() }, { headers: { 'Cache-Control': 'no-store' } });
};
