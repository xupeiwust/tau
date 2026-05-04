import { describe, it, expect } from 'vitest';
import { listDirectoryInputSchema } from '#schemas/tools/list-directory.tool.schema.js';

describe('listDirectoryInputSchema', () => {
  it('should document path relative to the project root', () => {
    const description = listDirectoryInputSchema.shape.path.description ?? '';
    expect(description.toLowerCase()).toContain('directory to list');
    expect(description.toLowerCase()).toContain('relative to the project root');
  });
});
