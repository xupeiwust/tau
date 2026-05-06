import { describe, expect, it } from 'vitest';
import type { GeneratedDoc } from 'fumadocs-typescript';
import { llmStringifyTypeTable } from '#lib/fumadocs/llm-stringify-type-table.js';

type MdxJsxFlowFixture = {
  type: 'mdxJsxFlowElement';
  name: string;
  attributes: Array<
    | { type: 'mdxJsxAttribute'; name: string; value: string }
    | {
        type: 'mdxJsxAttribute';
        name: string;
        value: { type: 'mdxJsxAttributeValueExpression'; value: string; data: unknown };
      }
  >;
  children: readonly never[];
};

const typeTableFixture = (generatedDocument: GeneratedDoc): MdxJsxFlowFixture => ({
  type: 'mdxJsxFlowElement',
  name: 'TypeTable',
  attributes: [
    {
      type: 'mdxJsxAttribute',
      name: 'id',
      value: `type-table-${generatedDocument.id}`,
    },
    {
      type: 'mdxJsxAttribute',
      name: 'type',
      value: {
        type: 'mdxJsxAttributeValueExpression',
        value: JSON.stringify(generatedDocument, null, 2),
        data: { estree: { type: 'Program', sourceType: 'module', body: [] } },
      },
    },
  ],
  children: [],
});

describe('llmStringifyTypeTable', () => {
  it('returns undefined for non-TypeTable mdx elements', () => {
    const node: MdxJsxFlowFixture = {
      type: 'mdxJsxFlowElement',
      name: 'Callout',
      attributes: [],
      children: [],
    };
    expect(llmStringifyTypeTable(node)).toBeUndefined();
  });

  it('returns undefined for TypeTable without a type attribute JSON string', () => {
    const node: MdxJsxFlowFixture = {
      type: 'mdxJsxFlowElement',
      name: 'TypeTable',
      attributes: [{ type: 'mdxJsxAttribute', name: 'id', value: 'x' }],
      children: [],
    };
    expect(llmStringifyTypeTable(node)).toBeUndefined();
  });

  it('returns undefined when type JSON is not a valid GeneratedDoc', () => {
    const node: MdxJsxFlowFixture = {
      type: 'mdxJsxFlowElement',
      name: 'TypeTable',
      attributes: [
        {
          type: 'mdxJsxAttribute',
          name: 'type',
          value: {
            type: 'mdxJsxAttributeValueExpression',
            value: '{"foo":1}',
            data: { estree: { type: 'Program', sourceType: 'module', body: [] } },
          },
        },
      ],
      children: [],
    };
    expect(llmStringifyTypeTable(node)).toBeUndefined();
  });

  it('returns undefined when type JSON parse throws', () => {
    const node: MdxJsxFlowFixture = {
      type: 'mdxJsxFlowElement',
      name: 'TypeTable',
      attributes: [
        {
          type: 'mdxJsxAttribute',
          name: 'type',
          value: {
            type: 'mdxJsxAttributeValueExpression',
            value: '{not json',
            data: { estree: { type: 'Program', sourceType: 'module', body: [] } },
          },
        },
      ],
      children: [],
    };
    expect(llmStringifyTypeTable(node)).toBeUndefined();
  });

  it('renders a single-entry GFM table with required and description', () => {
    const generatedDocument: GeneratedDoc = {
      id: 't.ts-Foo',
      name: 'Foo',
      description: 'A test type.',
      entries: [
        {
          name: 'bar',
          description: 'Bar field.',
          type: 'string',
          simplifiedType: 'string',
          tags: [],
          required: true,
          deprecated: false,
        },
      ],
    };
    const out = llmStringifyTypeTable(typeTableFixture(generatedDocument));
    expect(out).toContain('**`Foo`** — A test type.');
    expect(out).toContain('| Prop | Type | Required | Description |');
    expect(out).toContain('| `bar` | string | Yes | Bar field. |');
  });

  it('escapes pipes in the Type column', () => {
    const generatedDocument: GeneratedDoc = {
      id: 't.ts-Union',
      name: 'UnionType',
      entries: [
        {
          name: 'x',
          description: 'd',
          type: 'string[] | undefined',
          simplifiedType: 'union',
          tags: [],
          required: false,
          deprecated: false,
        },
      ],
    };
    const out = llmStringifyTypeTable(typeTableFixture(generatedDocument));
    expect(out).toContain('| `x` | string[] \\| undefined | No | d |');
  });

  it('collapses multiline descriptions into br-separated cells', () => {
    const generatedDocument: GeneratedDoc = {
      id: 't.ts-Multi',
      name: 'Multi',
      entries: [
        {
          name: 'a',
          description: 'Line one.\nLine two.',
          type: 'number',
          simplifiedType: 'number',
          tags: [],
          required: true,
          deprecated: false,
        },
      ],
    };
    const out = llmStringifyTypeTable(typeTableFixture(generatedDocument));
    expect(out).toContain('Line one.<br>Line two.');
  });

  it('marks deprecated props with strikethrough', () => {
    const generatedDocument: GeneratedDoc = {
      id: 't.ts-Dep',
      name: 'Dep',
      entries: [
        {
          name: 'old',
          description: 'gone',
          type: 'string',
          simplifiedType: 'string',
          tags: [],
          required: false,
          deprecated: true,
        },
      ],
    };
    const out = llmStringifyTypeTable(typeTableFixture(generatedDocument));
    expect(out).toContain('| ~~`old`~~ |');
  });

  it('prefixes default tag as (default: …) ahead of description', () => {
    const generatedDocument: GeneratedDoc = {
      id: 't.ts-Def',
      name: 'Def',
      entries: [
        {
          name: 'n',
          description: 'count',
          type: 'number',
          simplifiedType: 'number',
          tags: [{ name: 'default', text: '"foo"' }],
          required: false,
          deprecated: false,
        },
      ],
    };
    const out = llmStringifyTypeTable(typeTableFixture(generatedDocument));
    expect(out).toContain('(default: "foo") count');
  });

  it('appends non-default tags to the description', () => {
    const generatedDocument: GeneratedDoc = {
      id: 't.ts-Tags',
      name: 'Tags',
      entries: [
        {
          name: 'p',
          description: 'body',
          type: 'string',
          simplifiedType: 'string',
          tags: [{ name: 'example', text: '`x`' }],
          required: true,
          deprecated: false,
        },
      ],
    };
    const out = llmStringifyTypeTable(typeTableFixture(generatedDocument));
    expect(out).toContain('; tags: example=`x`');
  });

  it('emits _No properties._ when entries is empty', () => {
    const generatedDocument: GeneratedDoc = {
      id: 't.ts-Empty',
      name: 'Empty',
      entries: [],
    };
    const out = llmStringifyTypeTable(typeTableFixture(generatedDocument));
    expect(out).toContain('**`Empty`**');
    expect(out).toContain('_No properties._');
    expect(out).not.toContain('| Prop |');
  });

  it('accepts a plain string type attribute (no mdxJsxAttributeValueExpression)', () => {
    const generatedDocument: GeneratedDoc = {
      id: 'plain',
      name: 'Plain',
      entries: [
        {
          name: 'x',
          description: 'y',
          type: 'boolean',
          simplifiedType: 'boolean',
          tags: [],
          required: true,
          deprecated: false,
        },
      ],
    };
    const node: MdxJsxFlowFixture = {
      type: 'mdxJsxFlowElement',
      name: 'TypeTable',
      attributes: [
        { type: 'mdxJsxAttribute', name: 'id', value: 'id' },
        { type: 'mdxJsxAttribute', name: 'type', value: JSON.stringify(generatedDocument) },
      ],
      children: [],
    };
    const out = llmStringifyTypeTable(node);
    expect(out).toContain('| `x` | boolean | Yes | y |');
  });

  it('returns undefined for non-mdx root nodes', () => {
    const paragraphLikeNode: unknown = { type: 'paragraph', children: [] };
    expect(llmStringifyTypeTable(paragraphLikeNode)).toBeUndefined();
  });
});
