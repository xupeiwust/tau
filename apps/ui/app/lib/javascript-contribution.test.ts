import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ActivationContext, LanguageContribution } from '#lib/monaco-language-registry.js';
import type { MonacoTestStub } from '#lib/testing/monaco-language-stub.js';
import { LanguageContributionRegistry } from '#lib/monaco-language-registry.js';
import { createMonacoTestStub } from '#lib/testing/monaco-language-stub.js';

/* eslint-disable @typescript-eslint/naming-convention -- mocks must mirror PascalCase exports from the real module surface */

const ataConstructorCalls = vi.fn();
const ataInstance = {
  initialize: vi.fn(),
  startWatching: vi.fn(),
  dispose: vi.fn(),
  onProjectSessionChange: vi.fn(),
};

vi.mock('#lib/type-acquisition-service.js', () => ({
  TypeAcquisitionService: vi.fn().mockImplementation(function MockAta(...args: unknown[]) {
    ataConstructorCalls(...args);
    return ataInstance;
  }),
}));

vi.mock('@taucad/api-extractor', () => ({
  kernelTypeMaps: [],
}));

function attachTypescriptShim(stub: MonacoTestStub): void {
  Object.assign(stub.monaco, {
    typescript: {
      typescriptDefaults: {
        setCompilerOptions: vi.fn(),
        setEagerModelSync: vi.fn(),
      },
      javascriptDefaults: {
        setCompilerOptions: vi.fn(),
        setEagerModelSync: vi.fn(),
      },
      ModuleResolutionKind: { NodeJs: 'NodeJs' },
      ScriptTarget: { ESNext: 'ESNext' },
      ModuleKind: { ESNext: 'ESNext' },
    },
  });
}

/* eslint-enable @typescript-eslint/naming-convention -- end of mock declarations */

function createMockContext(stub: MonacoTestStub): ActivationContext {
  // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal context for jsTsContribution.activate
  return {
    monaco: stub.monaco,
    fileManager: {
      readFile: vi.fn(async () => new Uint8Array()),
      exists: vi.fn(async () => false),
      readdir: vi.fn(async () => []),
      getDirectoryStat: vi.fn(),
    },
  } as unknown as ActivationContext;
}

describe('jsTsContribution', () => {
  let stub: MonacoTestStub;
  let registry: LanguageContributionRegistry;
  let jsTsContribution: LanguageContribution;
  let context: ActivationContext;

  beforeEach(async () => {
    stub = createMonacoTestStub();
    attachTypescriptShim(stub);
    registry = new LanguageContributionRegistry();
    ataConstructorCalls.mockClear();
    for (const mockFunction of Object.values(ataInstance)) {
      mockFunction.mockClear();
    }

    const contributionModule = await import('#lib/javascript-contribution.js');
    jsTsContribution = contributionModule.jsTsContribution;
    context = createMockContext(stub);
  });

  afterEach(() => {
    registry.dispose();
    stub.__reset();
    vi.clearAllMocks();
  });

  it('should expose activationLanguageIds === ["typescript", "javascript", "typescriptreact", "javascriptreact"]', () => {
    expect(jsTsContribution.activationLanguageIds).toEqual([
      'typescript',
      'javascript',
      'typescriptreact',
      'javascriptreact',
    ]);
  });

  it('should not initialize TypeAcquisitionService when no JS/TS model exists', () => {
    registry.addContribution(jsTsContribution);
    registry.activate(context);

    expect(ataConstructorCalls).not.toHaveBeenCalled();
  });

  it('should initialize TypeAcquisitionService exactly once when a typescript model is created', () => {
    registry.addContribution(jsTsContribution);
    registry.activate(context);

    stub.__createModel('inmemory://t/0', 'typescript');

    expect(ataConstructorCalls).toHaveBeenCalledTimes(1);
    expect(ataInstance.initialize).toHaveBeenCalledTimes(1);
    expect(ataInstance.startWatching).toHaveBeenCalledTimes(1);
  });

  it('should initialize TypeAcquisitionService exactly once when both typescript and tsx models are created', () => {
    registry.addContribution(jsTsContribution);
    registry.activate(context);

    stub.__createModel('inmemory://t/0', 'typescript');
    stub.__createModel('inmemory://t/1', 'typescriptreact');

    expect(ataConstructorCalls).toHaveBeenCalledTimes(1);
  });

  it('should register definition providers for all four js/ts language ids on first activation', () => {
    const definitionSpy = vi.spyOn(stub.monaco.languages, 'registerDefinitionProvider');

    registry.addContribution(jsTsContribution);
    registry.activate(context);

    stub.__createModel('inmemory://t/0', 'typescript');

    const registeredIds = definitionSpy.mock.calls.map(([id]) => id);
    expect(registeredIds).toEqual(
      expect.arrayContaining(['typescript', 'javascript', 'typescriptreact', 'javascriptreact']),
    );
    expect(definitionSpy).toHaveBeenCalledTimes(4);
  });

  it('should activate when only a javascriptreact model exists', () => {
    registry.addContribution(jsTsContribution);
    registry.activate(context);

    stub.__createModel('inmemory://j/0', 'javascriptreact');

    expect(ataConstructorCalls).toHaveBeenCalledTimes(1);
  });
});
