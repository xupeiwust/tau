import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { validateJsdocCodeblocksRule } from './validate-jsdoc-codeblocks.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
  },
});

describe('validate-jsdoc-codeblocks', () => {
  describe('language tag requirement', () => {
    it('should report codeblocks without a language tag', () => {
      ruleTester.run('validate-jsdoc-codeblocks', validateJsdocCodeblocksRule, {
        valid: [
          {
            name: 'codeblock with ts language tag',
            code: `
/**
 * @public
 * \`\`\`ts
 * const x: number = 1;
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: 'codeblock with json language tag',
            code: `
/**
 * @public
 * \`\`\`json
 * { "key": "value" }
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: 'codeblock with text language tag',
            code: `
/**
 * @public
 * \`\`\`text
 * Some plain text
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: 'non-JSDoc block comment is ignored',
            code: `
/* Not a JSDoc comment
\`\`\`
no lang
\`\`\`
*/
const foo = 1;
`,
          },
          {
            name: 'line comments are ignored',
            code: '// Just a line comment\nconst foo = 1;',
          },
        ],
        invalid: [
          {
            name: 'codeblock without language tag in JSDoc',
            code: `
/**
 * @public
 * \`\`\`
 * const x = 1;
 * \`\`\`
 */
export const foo = 1;
`,
            errors: [{ messageId: 'missingLanguageTag' }],
          },
        ],
      });
    });
  });

  describe('TypeScript compilation', () => {
    it('should report TypeScript errors in @public codeblocks', () => {
      ruleTester.run('validate-jsdoc-codeblocks', validateJsdocCodeblocksRule, {
        valid: [
          {
            name: 'valid TypeScript in @public JSDoc',
            code: `
/**
 * @public
 * \`\`\`ts
 * const x: number = 1;
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: 'TypeScript in non-@public JSDoc is not compile-checked',
            code: `
/**
 * @internal
 * \`\`\`ts
 * const x: number = "not a number";
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: 'TypeScript in untagged JSDoc is not compile-checked',
            code: `
/**
 * \`\`\`ts
 * const x: number = "not a number";
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: 'non-TypeScript codeblock in @public JSDoc skips compilation',
            code: `
/**
 * @public
 * \`\`\`json
 * { "invalid": json }
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: 'empty TypeScript codeblock in @public JSDoc',
            code: `
/**
 * @public
 * \`\`\`ts
 * \`\`\`
 */
export const foo = 1;
`,
          },
        ],
        invalid: [
          {
            name: 'type error in @public TypeScript codeblock',
            code: `
/**
 * @public
 * \`\`\`ts
 * const x: number = "not a number";
 * \`\`\`
 */
export const foo = 1;
`,
            errors: [{ messageId: 'invalidCodeblock' }],
          },
          {
            name: 'syntax error in @public TypeScript codeblock',
            code: `
/**
 * @public
 * \`\`\`ts
 * const x: = ;
 * \`\`\`
 */
export const foo = 1;
`,
            errors: [{ messageId: 'invalidCodeblock' }, { messageId: 'invalidCodeblock' }],
          },
        ],
      });
    });
  });

  describe('star-prefix stripping', () => {
    it('should correctly compile codeblocks with star prefixes', () => {
      ruleTester.run('validate-jsdoc-codeblocks', validateJsdocCodeblocksRule, {
        valid: [
          {
            name: 'standard JSDoc formatting with star prefixes compiles correctly',
            code: `
/**
 * @public
 * \`\`\`typescript
 * const greeting: string = "hello";
 * const count: number = 42;
 * \`\`\`
 */
export const foo = 1;
`,
          },
        ],
        invalid: [],
      });
    });
  });

  describe('multiple codeblocks', () => {
    it('should report errors only for invalid codeblocks when multiple are present', () => {
      ruleTester.run('validate-jsdoc-codeblocks', validateJsdocCodeblocksRule, {
        valid: [
          {
            name: 'multiple valid TypeScript codeblocks',
            code: `
/**
 * @public
 * \`\`\`ts
 * const a: number = 1;
 * \`\`\`
 *
 * \`\`\`ts
 * const b: string = "hello";
 * \`\`\`
 */
export const foo = 1;
`,
          },
        ],
        invalid: [
          {
            name: 'one valid and one invalid codeblock',
            code: `
/**
 * @public
 * \`\`\`ts
 * const a: number = 1;
 * \`\`\`
 *
 * \`\`\`ts
 * const b: number = "wrong";
 * \`\`\`
 */
export const foo = 1;
`,
            errors: [{ messageId: 'invalidCodeblock' }],
          },
        ],
      });
    });
  });

  describe('@public tag variants', () => {
    it('should only compile-check codeblocks with @public tag', () => {
      ruleTester.run('validate-jsdoc-codeblocks', validateJsdocCodeblocksRule, {
        valid: [
          {
            name: '@publicAPI should not match (only exact @public)',
            code: `
/**
 * @publicAPI
 * \`\`\`ts
 * const x: number = "not a number";
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: '@public at end of JSDoc line',
            code: `
/**
 * Some docs @public
 * \`\`\`ts
 * const x: number = 1;
 * \`\`\`
 */
export const foo = 1;
`,
          },
          {
            name: '@public followed by star (JSDoc continuation)',
            code: `
/**
 * @public
 * \`\`\`ts
 * const x: number = 1;
 * \`\`\`
 */
export const foo = 1;
`,
          },
        ],
        invalid: [],
      });
    });
  });
});
