/**
 * @typedef {import('eslint').Rule.RuleModule} RuleModule
 * @typedef {import('eslint').Rule.RuleContext} RuleContext
 * @typedef {import('estree').Node} Node
 * @typedef {import('estree').NewExpression} NewExpression
 * @typedef {import('estree').Expression} Expression
 * @typedef {import('estree').SpreadElement} SpreadElement
 * @typedef {import('estree').TemplateLiteral} TemplateLiteral
 */

/**
 * Enforce that the first argument of `new URL(<path>, import.meta.url)` is a
 * static string literal (or a template literal whose only segments are static
 * strings, no `${...}` expressions).
 *
 * Bundlers (Vite/Rolldown, Webpack 5, Parcel 2, esbuild) recognise this exact
 * pattern as a first-class asset reference: they statically lift the literal
 * to a hashed asset URL during build. Any other shape (variable, function
 * call, template literal with expressions) opts the call out of asset emission
 * and silently breaks downstream consumers — the WASM/font/plugin chunk no
 * longer ships beside the bundle.
 *
 * See `docs/research/runtime-zero-config-bundling.md` (Finding 1, R5).
 */

/**
 * @param {Expression} node
 * @returns {boolean}
 */
const isImportMetaUrl = (node) => {
  if (node.type !== 'MemberExpression') {
    return false;
  }
  const { property } = node;
  if (property.type !== 'Identifier' || property.name !== 'url') {
    return false;
  }
  const { object } = node;
  return object.type === 'MetaProperty' && object.meta.name === 'import' && object.property.name === 'meta';
};

/**
 * @param {TemplateLiteral} template
 * @returns {boolean}
 */
const isStaticTemplate = (template) => template.expressions.length === 0;

/**
 * @param {Expression} node
 * @returns {boolean}
 */
const isStaticString = (node) => {
  if (node.type === 'Literal') {
    return typeof node.value === 'string';
  }
  if (node.type === 'TemplateLiteral') {
    return isStaticTemplate(node);
  }
  return false;
};

const ruleDescription = [
  'Require the first argument of `new URL(<path>, import.meta.url)` to be a static string literal so bundlers ',
  '(Vite/Rolldown, Webpack 5, Parcel 2, esbuild) can statically lift the asset to a hashed URL during build. ',
  'Variable or computed first arguments silently opt out of asset emission and break downstream consumers — ',
  'the WASM/font/plugin chunk no longer ships beside the bundle. ',
  'See docs/research/runtime-zero-config-bundling.md (Finding 1).',
].join('');

const dollarBrace = `${String.fromCodePoint(36)}{...}`;
const nonStaticArgumentMessage = [
  'First argument to `new URL(..., import.meta.url)` must be a string literal (or template literal without ',
  '`',
  dollarBrace,
  '` expressions) so bundlers can lift the asset to a hashed URL. ',
  'Computed paths silently opt out of asset emission. ',
  'See docs/research/runtime-zero-config-bundling.md (Finding 1).',
].join('');

/** @type {RuleModule} */
export const staticImportMetaUrlRule = {
  meta: {
    type: 'problem',
    docs: { description: ruleDescription },
    messages: { nonStaticArg: nonStaticArgumentMessage },
    schema: [],
  },
  create(context) {
    return {
      /**
       * @param {NewExpression} node
       */
      NewExpression(node) {
        const { callee } = node;
        if (callee.type !== 'Identifier' || callee.name !== 'URL') {
          return;
        }
        if (node.arguments.length < 2) {
          return;
        }
        const secondArgument = node.arguments[1];
        if (!isImportMetaUrl(secondArgument)) {
          return;
        }
        const firstArgument = node.arguments[0];
        if (isStaticString(firstArgument)) {
          return;
        }
        context.report({ node: firstArgument, messageId: 'nonStaticArg' });
      },
    };
  },
};
