import { flatRoutes } from '@react-router/fs-routes';
import type { RouteConfigEntry } from '@react-router/dev/routes';

// oxlint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- explicit module boundary required here.
export default flatRoutes({
  // Co-located route tests (e.g. `health.live.test.ts`) live next to the
  // route module they exercise. Without explicit ignore globs, flatRoutes
  // would treat `<segment>.test.ts(x)` as a real route, react-router's type
  // generator would emit a matching `+types/<segment>.test.ts(x)` file under
  // `.react-router/types/`, and vitest would then discover those generated
  // .test.ts files and fail with "No test suite found in file ...".
  ignoredRouteFiles: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
}) as Promise<RouteConfigEntry[]>;
