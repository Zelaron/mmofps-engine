import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capitalPropParts, type CapitalPropKind } from '../src/render/capital-props.js';
const kinds:CapitalPropKind[]=['vesper-spire','vesper-portal','vesper-beacon','aurelia-dome','aurelia-buttress','aurelia-standard'];

test('capital ornaments provide immutable instancing resources with normalized bounds and bounded detail',t=>{
  const geometries=new Set();
  for(const kind of kinds){let triangles=0;const parts=capitalPropParts(kind);assert.equal(parts,capitalPropParts(kind));assert.ok(parts.length<=2);
    for(const {geometry,material} of parts){assert.ok(!geometries.has(geometry));geometries.add(geometry);
      geometry.computeBoundingBox();const box=geometry.boundingBox!;assert.ok(box.min.y>=-.002&&box.max.y<=1.01,`${kind}: Y${box.min.y}..${box.max.y}`);
      assert.ok(box.min.x>=-.51&&box.max.x<=.51&&box.min.z>=-.51&&box.max.z<=.51,`${kind}: normalized width/depth`);
      triangles+=(geometry.index?.count??geometry.getAttribute('position').count)/3;assert.equal(geometry.groups.length,0);
      for(const attr of ['position','normal','color'])assert.ok(Array.from(geometry.getAttribute(attr).array).every(Number.isFinite));
      assert.equal(material.transparent,false);
    }
    assert.ok(triangles<=2400,`${kind}: ${triangles}`);t.diagnostic(`${kind}: ${parts.length} batches,${triangles} triangles`);
  }
});
