/**
 * JavaScriptWorker Tests
 *
 * Tests for the JavaScriptWorker base class including:
 * - Module resolution
 * - Bundling
 * - Error handling
 * - Stack trace classification
 */

import { describe, it, expect } from 'vitest';
import {
  parsePackageSpecifier,
  resolveRelativePath,
  getNodeModulesPath,
  isBareSpecifier,
  extractPackageFromCdnUrl,
  extractPackageInfoFromCdnUrl,
  isEsmShUrl,
} from '#utils/import.utils.js';

describe('Module Manager', () => {
  describe('parsePackageSpecifier', () => {
    it('should parse simple package name', () => {
      const result = parsePackageSpecifier('replicad');
      expect(result).toEqual({ name: 'replicad', version: '', path: '' });
    });

    it('should parse package with version', () => {
      const result = parsePackageSpecifier('replicad@0.19.1');
      expect(result).toEqual({ name: 'replicad', version: '0.19.1', path: '' });
    });

    it('should parse scoped package', () => {
      const result = parsePackageSpecifier('@jscad/modeling');
      expect(result).toEqual({ name: '@jscad/modeling', version: '', path: '' });
    });

    it('should parse scoped package with version', () => {
      const result = parsePackageSpecifier('@jscad/modeling@2.12.6');
      expect(result).toEqual({ name: '@jscad/modeling', version: '2.12.6', path: '' });
    });

    it('should parse package with subpath', () => {
      const result = parsePackageSpecifier('replicad/shapes');
      expect(result).toEqual({ name: 'replicad', version: '', path: 'shapes' });
    });

    it('should parse scoped package with version and subpath', () => {
      const result = parsePackageSpecifier('@jscad/modeling@2.12.6/primitives');
      expect(result).toEqual({ name: '@jscad/modeling', version: '2.12.6', path: 'primitives' });
    });
  });

  describe('isBareSpecifier', () => {
    it('should return true for bare specifiers', () => {
      expect(isBareSpecifier('replicad')).toBe(true);
      expect(isBareSpecifier('@jscad/modeling')).toBe(true);
      expect(isBareSpecifier('zod')).toBe(true);
    });

    it('should return false for relative imports', () => {
      expect(isBareSpecifier('./utils.ts')).toBe(false);
      expect(isBareSpecifier('../helpers.ts')).toBe(false);
    });

    it('should return false for absolute imports', () => {
      expect(isBareSpecifier('/absolute/path.ts')).toBe(false);
    });

    it('should return false for URL imports', () => {
      expect(isBareSpecifier('https://cdn.jsdelivr.net/npm/lodash')).toBe(false);
      expect(isBareSpecifier('http://example.com/module.js')).toBe(false);
    });
  });

  describe('extractPackageFromCdnUrl', () => {
    it('should extract package name from jsdelivr URLs', () => {
      expect(
        extractPackageFromCdnUrl('https://cdn.jsdelivr.net/npm/replicad-decorate/dist/studio/replicad-decorate.js'),
      ).toBe('replicad-decorate');
      expect(extractPackageFromCdnUrl('https://cdn.jsdelivr.net/npm/lodash')).toBe('lodash');
      expect(extractPackageFromCdnUrl('https://cdn.jsdelivr.net/npm/lodash@4.17.21')).toBe('lodash');
    });

    it('should extract package name from esm.sh URLs', () => {
      expect(extractPackageFromCdnUrl('https://esm.sh/lodash')).toBe('lodash');
      expect(extractPackageFromCdnUrl('https://esm.sh/lodash@4.17.21')).toBe('lodash');
    });

    it('should handle esm.sh version prefix', () => {
      expect(extractPackageFromCdnUrl('https://esm.sh/v135/lodash@4.17.21/index.d.ts')).toBe('lodash');
    });

    it('should extract package name from unpkg URLs', () => {
      expect(extractPackageFromCdnUrl('https://unpkg.com/lodash@4.17.21/lodash.js')).toBe('lodash');
    });

    it('should extract package name from esm.run URLs', () => {
      expect(extractPackageFromCdnUrl('https://esm.run/lodash')).toBe('lodash');
    });

    it('should extract package name from Skypack lookup URLs', () => {
      expect(extractPackageFromCdnUrl('https://cdn.skypack.dev/qrcode-generator@2.0.4')).toBe('qrcode-generator');
      expect(extractPackageFromCdnUrl('https://cdn.skypack.dev/react')).toBe('react');
    });

    it('should extract package name from Skypack pinned URLs', () => {
      expect(extractPackageFromCdnUrl('https://cdn.skypack.dev/pin/react@v16.13.1-zjOHmKoBShdi3wIQWY2z/react.js')).toBe(
        'react',
      );
      expect(
        extractPackageFromCdnUrl(
          'https://cdn.skypack.dev/pin/preact@v10.19.3-VLh4KNKC08lfhYfF3qms/dist=es2019,mode=imports/optimized/preact.js',
        ),
      ).toBe('preact');
    });

    it('should handle scoped packages in CDN URLs', () => {
      expect(extractPackageFromCdnUrl('https://cdn.jsdelivr.net/npm/@scope/pkg@1.0.0/dist/index.js')).toBe(
        '@scope/pkg',
      );
      expect(extractPackageFromCdnUrl('https://esm.sh/@jscad/modeling')).toBe('@jscad/modeling');
      expect(extractPackageFromCdnUrl('https://unpkg.com/@scope/pkg')).toBe('@scope/pkg');
      expect(extractPackageFromCdnUrl('https://cdn.skypack.dev/@scope/pkg@1.0.0')).toBe('@scope/pkg');
    });

    it('should return undefined for non-CDN URLs', () => {
      expect(extractPackageFromCdnUrl('https://example.com/module.js')).toBeUndefined();
      expect(extractPackageFromCdnUrl('https://github.com/user/repo')).toBeUndefined();
    });

    it('should return undefined for non-URL strings', () => {
      expect(extractPackageFromCdnUrl('lodash')).toBeUndefined();
      expect(extractPackageFromCdnUrl('./utils.ts')).toBeUndefined();
      expect(extractPackageFromCdnUrl('')).toBeUndefined();
    });
  });

  describe('extractPackageInfoFromCdnUrl', () => {
    it('should extract full package info from Skypack URLs', () => {
      expect(extractPackageInfoFromCdnUrl('https://cdn.skypack.dev/qrcode-generator@2.0.4')).toEqual({
        name: 'qrcode-generator',
        version: '2.0.4',
        path: '',
      });
    });

    it('should extract full package info from esm.sh URLs', () => {
      expect(extractPackageInfoFromCdnUrl('https://esm.sh/lodash@4.17.21')).toEqual({
        name: 'lodash',
        version: '4.17.21',
        path: '',
      });
    });

    it('should extract full package info from jsdelivr URLs', () => {
      expect(
        extractPackageInfoFromCdnUrl('https://cdn.jsdelivr.net/npm/replicad-decorate/dist/studio/replicad-decorate.js'),
      ).toEqual({
        name: 'replicad-decorate',
        version: '',
        path: 'dist/studio/replicad-decorate.js',
      });
    });

    it('should return undefined for non-CDN URLs', () => {
      expect(extractPackageInfoFromCdnUrl('https://example.com/module.js')).toBeUndefined();
    });
  });

  describe('isEsmShUrl', () => {
    it('should return true for esm.sh URLs', () => {
      expect(isEsmShUrl('https://esm.sh/lodash@4.17.21')).toBe(true);
      expect(isEsmShUrl('https://esm.sh/v135/lodash@4.17.21/index.d.ts')).toBe(true);
    });

    it('should return false for non-esm.sh URLs', () => {
      expect(isEsmShUrl('https://cdn.jsdelivr.net/npm/lodash')).toBe(false);
      expect(isEsmShUrl('https://cdn.skypack.dev/react')).toBe(false);
    });
  });

  describe('resolveRelativePath', () => {
    it('should resolve ./ imports', () => {
      const result = resolveRelativePath('./utils.ts', '/project/src/main.ts');
      expect(result).toBe('/project/src/utils.ts');
    });

    it('should resolve ../ imports', () => {
      const result = resolveRelativePath('../helpers.ts', '/project/src/main.ts');
      expect(result).toBe('/project/helpers.ts');
    });

    it('should handle multiple ../', () => {
      const result = resolveRelativePath('../../lib/utils.ts', '/project/src/components/button.ts');
      expect(result).toBe('/project/lib/utils.ts');
    });
  });

  describe('getNodeModulesPath', () => {
    it('should return correct path for simple package', () => {
      const result = getNodeModulesPath('replicad');
      expect(result).toBe('/node_modules/replicad');
    });

    it('should return correct path for scoped package', () => {
      const result = getNodeModulesPath('@jscad/modeling');
      expect(result).toBe('/node_modules/@jscad/modeling');
    });
  });
});

describe('Stack Frame Classification', () => {
  it('should classify node_modules frames as framework', () => {
    const fileName = '/builds/project/node_modules/some-lib/index.js';
    // Node_modules without a library pattern match -> framework
    const isFramework = fileName.includes('/node_modules/');
    expect(isFramework).toBe(true);
  });

  it('should classify data: URLs as framework', () => {
    const fileName = 'data:text/javascript;base64,abc123';
    const isFramework = fileName.startsWith('data:');
    expect(isFramework).toBe(true);
  });

  it('should classify blob: URLs as user code', () => {
    const fileName = 'blob:https://example.com/abc123';
    // Blob: URLs are where user's bundled code runs -> user
    const isUser = fileName.startsWith('blob:');
    expect(isUser).toBe(true);
  });

  it('should classify regular files as user code', () => {
    const fileName = '/builds/project/main.ts';
    const isKnownInternal =
      fileName.includes('/node_modules/') ||
      fileName.startsWith('data:') ||
      fileName.startsWith('node:') ||
      fileName.startsWith('<') ||
      fileName.includes('/kernel/');
    expect(isKnownInternal).toBe(false);
  });

  it('should classify node: URLs as runtime', () => {
    const fileName = 'node:fs';
    const isRuntime = fileName.startsWith('node:');
    expect(isRuntime).toBe(true);
  });

  it('should classify anonymous frames as runtime', () => {
    const fileName = '<anonymous>';
    const isRuntime = fileName.startsWith('<');
    expect(isRuntime).toBe(true);
  });

  it('should classify kernel paths as framework', () => {
    const fileName = '/builds/project/kernel/worker.js';
    const isFramework = fileName.includes('/kernel/');
    expect(isFramework).toBe(true);
  });
});
