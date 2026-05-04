import type { Plugin } from 'vite';

/**
 * Workaround for a Vite 8 beta bug where the internal `vite:asset-import-meta-url`
 * plugin uses a code filter regex (`/new\s+URL.+import\.meta\.url/s`) that overflows
 * V8's RegExp stack when tested against very large pre-bundled dependency chunks
 * (e.g. Monaco Editor's ~6MB `editor.api2-*.js`).
 *
 * This plugin replaces the problematic dotAll regex with a simple string check
 * (`"import.meta.url"`) which is a necessary condition for the regex to match.
 * The replacement is safe because the plugin's transform handler already performs
 * its own precise regex matching — the filter is only a fast pre-check.
 *
 * **Authoring rule:** Custom Vite/Rolldown plugins that scan transform input must gate any tokenizer or
 * full-source regex behind a cheap pre-filter (substring or sticky regex without quantified-alternation over
 * unbounded spans). Prefer the same layering as upstream vitejs/vite#21800. In-repo reference:
 * `ts-module-url.vite-plugin.ts`; analysis: `docs/research/vite-plugin-large-string-literal-overflow.md`.
 *
 * @public
 */
export function largeDepRegexFix(): Plugin {
  return {
    name: 'vite:large-dep-regex-fix',
    enforce: 'pre',

    configResolved(config) {
      for (const plugin of config.plugins) {
        if (plugin.name !== 'vite:asset-import-meta-url') {
          continue;
        }

        const { transform } = plugin;
        if (transform && typeof transform === 'object' && 'filter' in transform && transform.filter) {
          const filter = transform.filter as { code?: unknown };
          if (filter.code instanceof RegExp) {
            filter.code = 'import.meta.url';
          }
        }
      }
    },
  };
}
