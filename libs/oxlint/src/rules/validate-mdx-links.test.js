import { describe, it, vi, beforeEach } from 'vitest';
import { RuleTester } from 'eslint';

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
  },
  existsSync: vi.fn(() => false),
}));

const fs = await import('node:fs');
const { validateMdxLinksRule } = await import('./validate-mdx-links.js');
const mdxParser = await import('../mdx-parser.js');

const ruleTester = new RuleTester({
  languageOptions: { parser: mdxParser },
});

/**
 * @param {Record<string, boolean>} pathMap
 */
const mockFs = (pathMap) => {
  vi.mocked(fs.default.existsSync).mockImplementation((/** @type {string} */ p) => pathMap[String(p)] ?? false);
};

describe('validate-mdx-links', () => {
  beforeEach(() => {
    vi.mocked(fs.default.existsSync).mockReturnValue(false);
  });

  describe('valid cases', () => {
    it('should skip external and special links', () => {
      ruleTester.run('validate-mdx-links', validateMdxLinksRule, {
        valid: [
          {
            name: 'https link is skipped',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'Check [Google](https://google.com) for more.',
          },
          {
            name: 'http link is skipped',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'See [docs](http://example.com/docs).',
          },
          {
            name: 'mailto link is skipped',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'Email [us](mailto:hello@example.com).',
          },
          {
            name: 'anchor-only link is skipped',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'Jump to [section](#overview).',
          },
          {
            name: 'plain text with no links',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: '# Hello World\n\nSome text here.',
          },
        ],
        invalid: [],
      });
    });

    it('should pass when relative link targets exist', () => {
      mockFs({
        '/project/content/docs/runtime/api/client.mdx': true,
        '/project/content/docs/runtime/guides/custom-kernel.mdx': true,
      });

      ruleTester.run('validate-mdx-links', validateMdxLinksRule, {
        valid: [
          {
            name: 'relative link to sibling directory resolves',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'See [Client](../api/client) for details.',
          },
          {
            name: 'relative link to same directory resolves',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'See [Custom Kernel](./custom-kernel) guide.',
          },
        ],
        invalid: [],
      });
    });

    it('should pass when relative link with anchor targets exist', () => {
      mockFs({
        '/project/content/docs/runtime/api/client.mdx': true,
      });

      ruleTester.run('validate-mdx-links', validateMdxLinksRule, {
        valid: [
          {
            name: 'link with anchor is validated by base path',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'See [Client methods](../api/client#methods).',
          },
        ],
        invalid: [],
      });
    });

    it('should pass when target is an index page', () => {
      mockFs({
        '/project/content/docs/runtime/getting-started/index.mdx': true,
      });

      ruleTester.run('validate-mdx-links', validateMdxLinksRule, {
        valid: [
          {
            name: 'link resolves to directory index.mdx',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'Start with [Getting Started](../getting-started).',
          },
        ],
        invalid: [],
      });
    });

    it('should pass for valid absolute links', () => {
      mockFs({
        '/project/content/docs/runtime/api/client.mdx': true,
      });

      ruleTester.run('validate-mdx-links', validateMdxLinksRule, {
        valid: [
          {
            name: 'absolute link resolves under flat docs tree',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'See [Client](/docs/runtime/api/client).',
          },
        ],
        invalid: [],
      });
    });

    it('should resolve `.mdx` per-page resource-route URLs to the underlying page', () => {
      mockFs({
        '/project/content/docs/runtime/getting-started/installation.mdx': true,
        '/project/content/docs/runtime/api/client.mdx': true,
      });

      ruleTester.run('validate-mdx-links', validateMdxLinksRule, {
        valid: [
          {
            name: 'absolute .mdx URL resolves to underlying file',
            filename: '/project/content/docs/runtime/getting-started/llms-txt.mdx',
            code: 'See [Install](/docs/runtime/getting-started/installation.mdx).',
          },
          {
            name: 'relative .mdx URL resolves to underlying file',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'See [Client](../api/client.mdx).',
          },
        ],
        invalid: [],
      });
    });

    it('should skip loader-only resource-route URLs (.txt, .webmanifest)', () => {
      ruleTester.run('validate-mdx-links', validateMdxLinksRule, {
        valid: [
          {
            name: 'site-wide /llms.txt is skipped',
            filename: '/project/content/docs/runtime/getting-started/llms-txt.mdx',
            code: 'Site-wide [/llms.txt](/llms.txt) index.',
          },
          {
            name: 'tree-scoped /docs/runtime/llms.txt is skipped',
            filename: '/project/content/docs/runtime/getting-started/llms-txt.mdx',
            code: 'See [/docs/runtime/llms.txt](/docs/runtime/llms.txt).',
          },
          {
            name: 'site-wide /llms-full.txt is skipped',
            filename: '/project/content/docs/runtime/getting-started/llms-txt.mdx',
            code: 'Full markdown [/llms-full.txt](/llms-full.txt).',
          },
          {
            name: 'webmanifest URL is skipped',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'PWA manifest at [site.webmanifest](/site.webmanifest).',
          },
        ],
        invalid: [],
      });
    });

    it('should skip absolute links that are not under /docs/', () => {
      ruleTester.run('validate-mdx-links', validateMdxLinksRule, {
        valid: [
          {
            name: 'app route /pricing is skipped (rule cannot validate non-docs routes)',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'See [Pricing](/pricing) for plans.',
          },
          {
            name: 'app route /projects/abc is skipped',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'Open in [editor](/projects/example).',
          },
        ],
        invalid: [],
      });
    });

    it('should skip URLs with non-resource-route extensions', () => {
      ruleTester.run('validate-mdx-links', validateMdxLinksRule, {
        valid: [
          {
            name: 'png image link is skipped',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'See [diagram](/docs/runtime/diagrams/foo.png).',
          },
          {
            name: 'json link is skipped',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'See [data](./fixture.json).',
          },
        ],
        invalid: [],
      });
    });
  });

  describe('invalid cases', () => {
    it('should report broken relative links', () => {
      ruleTester.run('validate-mdx-links', validateMdxLinksRule, {
        valid: [],
        invalid: [
          {
            name: 'relative link to nonexistent page',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'See [Missing](../api/nonexistent) guide.',
            errors: [
              {
                messageId: 'deadLink',
                data: {
                  url: '../api/nonexistent',
                  resolvedPath: '/project/content/docs/runtime/api/nonexistent.mdx',
                },
              },
            ],
          },
          {
            name: 'relative link with anchor to nonexistent page',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'See [Missing](./does-not-exist#section).',
            errors: [
              {
                messageId: 'deadLink',
                data: {
                  url: './does-not-exist#section',
                  resolvedPath: '/project/content/docs/runtime/guides/does-not-exist.mdx',
                },
              },
            ],
          },
          {
            name: 'relative .mdx URL to nonexistent page',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'See [Missing](../api/nonexistent.mdx).',
            errors: [
              {
                messageId: 'deadLink',
                data: {
                  url: '../api/nonexistent.mdx',
                  resolvedPath: '/project/content/docs/runtime/api/nonexistent.mdx',
                },
              },
            ],
          },
        ],
      });
    });

    it('should report broken absolute links', () => {
      ruleTester.run('validate-mdx-links', validateMdxLinksRule, {
        valid: [],
        invalid: [
          {
            name: 'absolute link to nonexistent page',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'See [Missing](/docs/runtime/api/nonexistent).',
            errors: [
              {
                messageId: 'deadLink',
                data: {
                  url: '/docs/runtime/api/nonexistent',
                  resolvedPath: '/project/content/docs/runtime/api/nonexistent.mdx',
                },
              },
            ],
          },
          {
            name: 'absolute .mdx URL to nonexistent page',
            filename: '/project/content/docs/runtime/getting-started/llms-txt.mdx',
            code: 'See [Missing](/docs/runtime/api/nonexistent.mdx).',
            errors: [
              {
                messageId: 'deadLink',
                data: {
                  url: '/docs/runtime/api/nonexistent.mdx',
                  resolvedPath: '/project/content/docs/runtime/api/nonexistent.mdx',
                },
              },
            ],
          },
        ],
      });
    });

    it('should report multiple broken links in one file', () => {
      ruleTester.run('validate-mdx-links', validateMdxLinksRule, {
        valid: [],
        invalid: [
          {
            name: 'two broken links in same file',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'See [A](./missing-a) and [B](../concepts/missing-b).',
            errors: [{ messageId: 'deadLink' }, { messageId: 'deadLink' }],
          },
        ],
      });
    });

    it('should report dead link alongside valid link', () => {
      mockFs({
        '/project/content/docs/runtime/api/client.mdx': true,
      });

      ruleTester.run('validate-mdx-links', validateMdxLinksRule, {
        valid: [],
        invalid: [
          {
            name: 'one valid, one broken link',
            filename: '/project/content/docs/runtime/guides/test.mdx',
            code: 'See [Client](../api/client) and [Missing](./gone).',
            errors: [
              {
                messageId: 'deadLink',
                data: {
                  url: './gone',
                  resolvedPath: '/project/content/docs/runtime/guides/gone.mdx',
                },
              },
            ],
          },
        ],
      });
    });
  });
});
