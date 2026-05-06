import type { DocEntry, GeneratedDoc, RawTag } from 'fumadocs-typescript';

type MdxJsxAttributeValueExpression = {
  type: 'mdxJsxAttributeValueExpression';
  value: string;
};

type MdxJsxAttributeShape = {
  type: 'mdxJsxAttribute';
  name: string;
  value: string | undefined | MdxJsxAttributeValueExpression;
};

type MdxJsxElementShape = {
  type: 'mdxJsxFlowElement' | 'mdxJsxTextElement';
  name: string | undefined;
  attributes: MdxJsxAttributeShape[];
};

const collapseWhitespace = (value: string): string => value.replaceAll(/\s+/g, ' ').trim();

const escapeTablePipes = (value: string): string => value.replaceAll('|', String.raw`\|`);

const isMdxJsxAttributeShape = (value: unknown): value is MdxJsxAttributeShape => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const attribute = value as Record<string, unknown>;
  return attribute['type'] === 'mdxJsxAttribute' && typeof attribute['name'] === 'string';
};

const isMdxJsxElementShape = (value: unknown): value is MdxJsxElementShape => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const node = value as Record<string, unknown>;
  if (node['type'] !== 'mdxJsxFlowElement' && node['type'] !== 'mdxJsxTextElement') {
    return false;
  }

  if (typeof node['name'] !== 'string') {
    return false;
  }

  return Array.isArray(node['attributes']) && node['attributes'].every(isMdxJsxAttributeShape);
};

const isRawTag = (value: unknown): value is RawTag => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const tag = value as Record<string, unknown>;
  return typeof tag['name'] === 'string' && typeof tag['text'] === 'string';
};

const isDocumentEntry = (value: unknown): value is DocEntry => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const entry = value as Record<string, unknown>;
  if (typeof entry['name'] !== 'string') {
    return false;
  }

  if (typeof entry['description'] !== 'string') {
    return false;
  }

  if (typeof entry['type'] !== 'string') {
    return false;
  }

  if (typeof entry['simplifiedType'] !== 'string') {
    return false;
  }

  if (!Array.isArray(entry['tags']) || !entry['tags'].every(isRawTag)) {
    return false;
  }

  if (typeof entry['required'] !== 'boolean' || typeof entry['deprecated'] !== 'boolean') {
    return false;
  }

  if (entry['typeHref'] !== undefined && typeof entry['typeHref'] !== 'string') {
    return false;
  }

  return true;
};

const isGeneratedDocument = (value: unknown): value is GeneratedDoc => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const documentRecord = value as Record<string, unknown>;
  if (typeof documentRecord['id'] !== 'string' || typeof documentRecord['name'] !== 'string') {
    return false;
  }

  if (documentRecord['description'] !== undefined && typeof documentRecord['description'] !== 'string') {
    return false;
  }

  if (!Array.isArray(documentRecord['entries']) || !documentRecord['entries'].every(isDocumentEntry)) {
    return false;
  }

  return true;
};

const readAttributeString = (attribute: MdxJsxAttributeShape): string | undefined => {
  if (typeof attribute.value === 'string') {
    return attribute.value;
  }

  if (attribute.value?.type === 'mdxJsxAttributeValueExpression' && typeof attribute.value.value === 'string') {
    return attribute.value.value;
  }

  return undefined;
};

const readTypeAttributeJson = (node: MdxJsxElementShape): string | undefined => {
  for (const attribute of node.attributes) {
    if (attribute.name !== 'type') {
      continue;
    }

    const raw = readAttributeString(attribute);
    if (typeof raw === 'string' && raw.length > 0) {
      return raw;
    }
  }

  return undefined;
};

const readGeneratedDocument = (node: MdxJsxElementShape): GeneratedDoc | undefined => {
  const raw = readTypeAttributeJson(node);
  if (raw === undefined) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return isGeneratedDocument(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const formatEntryDescription = (entry: DocEntry): string => {
  const defaultTag = entry.tags.find((tag) => tag.name === 'default');
  const otherTags = entry.tags.filter((tag) => tag.name !== 'default');

  let text = '';
  if (defaultTag) {
    text += `(default: ${defaultTag.text}) `;
  }

  text += entry.description.replaceAll(/\r?\n/g, '<br>');

  if (otherTags.length > 0) {
    const serialized = otherTags.map((tag) => `${tag.name}=${tag.text}`).join(', ');
    text += `; tags: ${serialized}`;
  }

  return escapeTablePipes(text);
};

const renderTypeTable = (generatedDocument: GeneratedDoc): string => {
  const headerLine: string[] = [`**\`${generatedDocument.name}\`**`];
  if (generatedDocument.description && generatedDocument.description.length > 0) {
    const oneLine = collapseWhitespace(generatedDocument.description);
    if (oneLine.length > 0) {
      headerLine.push(` — ${oneLine}`);
    }
  }

  const lines: string[] = [headerLine.join('')];

  if (generatedDocument.entries.length === 0) {
    lines.push('_No properties._');
    return lines.join('\n\n');
  }

  lines.push('| Prop | Type | Required | Description |');
  lines.push('| --- | --- | --- | --- |');

  for (const entry of generatedDocument.entries) {
    const propertyCell = entry.deprecated ? `~~\`${entry.name}\`~~` : `\`${entry.name}\``;
    const typeCell = escapeTablePipes(collapseWhitespace(entry.type));
    const requiredCell = entry.required ? 'Yes' : 'No';
    const descriptionCell = formatEntryDescription(entry);
    lines.push(`| ${propertyCell} | ${typeCell} | ${requiredCell} | ${descriptionCell} |`);
  }

  return lines.join('\n');
};

/**
 * Custom MDAST stringifier hook for Fumadocs `includeProcessedMarkdown` / `_markdown`.
 * Replaces literal `<TypeTable type="{...JSON...}">` JSX in LLM-facing markdown with a GFM table
 * built from the embedded `GeneratedDoc` JSON. Returns `undefined` for all other nodes so the
 * default stringifier runs unchanged (browser MDX compilation is unaffected).
 */
export const llmStringifyTypeTable = (...stringifyArguments: readonly unknown[]): string | undefined => {
  const [maybeNode] = stringifyArguments;
  if (!isMdxJsxElementShape(maybeNode) || maybeNode.name !== 'TypeTable') {
    return undefined;
  }

  const generatedDocument = readGeneratedDocument(maybeNode);
  if (generatedDocument === undefined) {
    return undefined;
  }

  return renderTypeTable(generatedDocument);
};
