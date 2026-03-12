/**
 * Type-level tests for the opencascade.js bundled type declarations.
 *
 * Verifies that the generated .d.ts resolves correctly when registered
 * at file:///node_modules/opencascade.js/index.d.ts via Monaco's addExtraLib.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type {
  gp_Pnt,
  BRepPrimAPI_MakeBox,
  TopExp_Explorer,
  TopoDS_Shape,
  OpenCascadeInstance,
} from 'opencascade.js';
import type initOC from 'opencascade.js';
import type initAlias from 'opencascade';

describe('opencascade.js module resolution', () => {
  it('default export is an init function returning Promise<OpenCascadeInstance>', () => {
    expectTypeOf<typeof initOC>().toBeFunction();
    expectTypeOf<ReturnType<typeof initOC>>().toMatchTypeOf<Promise<OpenCascadeInstance>>();
  });

  it('exports key OCCT class types', () => {
    expectTypeOf<gp_Pnt>().toBeObject();
    expectTypeOf<BRepPrimAPI_MakeBox>().toBeObject();
    expectTypeOf<TopExp_Explorer>().toBeObject();
    expectTypeOf<TopoDS_Shape>().toBeObject();
  });

  it('OpenCascadeInstance has FS property', () => {
    expectTypeOf<OpenCascadeInstance>().toHaveProperty('FS');
  });

  it('class types have delete() method', () => {
    expectTypeOf<gp_Pnt>().toHaveProperty('delete');
    expectTypeOf<BRepPrimAPI_MakeBox>().toHaveProperty('delete');
    expectTypeOf<TopoDS_Shape>().toHaveProperty('delete');
  });

  it('class types have Symbol.dispose for using declarations', () => {
    expectTypeOf<gp_Pnt>().toHaveProperty(Symbol.dispose);
    expectTypeOf<BRepPrimAPI_MakeBox>().toHaveProperty(Symbol.dispose);
    expectTypeOf<TopoDS_Shape>().toHaveProperty(Symbol.dispose);
  });
});

describe('opencascade alias module resolution', () => {
  it('alias default export resolves to the same init function', () => {
    expectTypeOf<typeof initAlias>().toBeFunction();
    expectTypeOf<typeof initAlias>().toEqualTypeOf<typeof initOC>();
  });
});
