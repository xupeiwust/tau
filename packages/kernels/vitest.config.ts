import { defineConfig } from 'vitest/config';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

export default defineConfig({
  // oxlint-disable-next-line typescript/no-explicit-any -- vite type mismatch from pnpm duplicate @types/node resolutions
  plugins: [nxViteTsPaths() as any],
  test: {
    environment: 'node',
    typecheck: {
      enabled: true,
      include: ['**/*.test-d.ts'],
      tsconfig: './tsconfig.spec.json',
      ignoreSourceErrors: true,
    },
    reporters: ['verbose'],
    setupFiles: ['vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/packages/kernels',
      include: ['src/**/*'],
      exclude: ['src/**/*.{test,spec}.ts'],
    },
  },
});
