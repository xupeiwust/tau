// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loader } from '#routes/health.startup.js';

const callLoader = async () => {
  // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal stub for loader signature
  const args = {} as Parameters<typeof loader>[0];
  return (await loader(args)) as Response;
};

describe('GET /health/startup', () => {
  it('should return 200 + status:ok with non-negative uptime', async () => {
    const response = await callLoader();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; uptime: number };
    expect(body.status).toBe('ok');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
