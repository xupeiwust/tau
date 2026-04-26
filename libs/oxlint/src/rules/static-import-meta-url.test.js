import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { staticImportMetaUrlRule } from './static-import-meta-url.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

describe('static-import-meta-url', () => {
  it('flags non-literal first arguments to new URL(_, import.meta.url) and accepts static literals', () => {
    ruleTester.run('static-import-meta-url', staticImportMetaUrlRule, {
      valid: [
        {
          name: 'string literal first arg',
          code: "const u = new URL('wasm/replicad.wasm', import.meta.url).href;",
        },
        {
          name: 'template literal with no expressions',
          code: 'const u = new URL(`wasm/replicad.wasm`, import.meta.url).href;',
        },
        {
          name: 'single-arg new URL is unaffected',
          code: 'const u = new URL(args.path);',
        },
        {
          name: 'two-arg new URL whose second arg is not import.meta.url is unaffected',
          code: 'const u = new URL(args.path, args.importer);',
        },
        {
          name: 'two-arg new URL whose second arg is a base origin is unaffected',
          code: 'const u = new URL(args.path, importerUrl.origin);',
        },
        {
          name: 'non-URL constructor with import.meta.url is unaffected',
          code: 'const w = new Worker(somePath, import.meta.url);',
        },
      ],
      invalid: [
        {
          name: 'variable first argument',
          code: 'const path = "x.wasm"; const u = new URL(path, import.meta.url).href;',
          errors: [{ messageId: 'nonStaticArg' }],
        },
        {
          name: 'function-call first argument',
          code: 'const u = new URL(computeWasmPath(), import.meta.url).href;',
          errors: [{ messageId: 'nonStaticArg' }],
        },
        {
          // oxlint-disable-next-line eslint/no-template-curly-in-string -- the literal "${...}" is the rule fixture
          name: 'template literal containing ${expression}',
          // oxlint-disable-next-line eslint/no-template-curly-in-string -- fixture: the embedded backtick template is the input being tested
          code: 'const name = "replicad"; const u = new URL(`wasm/${name}.wasm`, import.meta.url).href;',
          errors: [{ messageId: 'nonStaticArg' }],
        },
        {
          name: 'logical-or fallback first argument',
          code: 'const fallback = "x.wasm"; const u = new URL(opts.url || fallback, import.meta.url).href;',
          errors: [{ messageId: 'nonStaticArg' }],
        },
        {
          name: 'numeric literal first argument (not a string)',
          code: 'const u = new URL(123, import.meta.url).href;',
          errors: [{ messageId: 'nonStaticArg' }],
        },
      ],
    });
  });
});
