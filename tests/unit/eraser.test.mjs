/**
 * Regression tests for OmniCanvas.performErase (partial eraser).
 *
 * The eraser compares path commands against a scene-space pointer, but
 * `obj.path` is stored in the path's own coordinate space. Brush strokes start
 * out in scene coordinates, so first-generation strokes erased correctly while
 * rebuilt fragments did not — they became impossible to erase a second time.
 *
 * These tests drive the real `performErase` against real fabric Path objects,
 * with only the canvas plumbing stubbed out (fabric's Canvas needs a DOM, and
 * these run in the node environment).
 */

import { describe, it, expect, vi } from "vitest";
import { Path } from "fabric";
import { OmniCanvas } from "../../src/canvas/engine.js";

/** Scene position of a path command, as the object would actually render it. */
const toScene = (obj, cmd) => {
  const m = obj.calcTransformMatrix();
  const off = obj.pathOffset;
  const x = cmd[cmd.length - 2] - off.x;
  const y = cmd[cmd.length - 1] - off.y;
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
};

/** Endpoints of a path in scene coordinates. */
const scenePoints = (obj) => obj.path.map((cmd) => toScene(obj, cmd));

const makeEngine = (objects, pointer) => {
  const engine = Object.create(OmniCanvas.prototype);
  engine.currentZoom = 1;
  engine.canvas = {
    backgroundImage: null,
    getObjects: () => objects.slice(),
    getScenePoint: () => pointer,
    add: (o) => objects.push(o),
    remove: (o) => {
      const i = objects.indexOf(o);
      if (i >= 0) objects.splice(i, 1);
    },
    discardActiveObject: () => {},
    getActiveObject: () => null,
    requestRenderAll: vi.fn(),
  };
  engine.recordHistory = vi.fn();
  return engine;
};

/** Stroke shaped like PencilBrush output: absolute scene coordinates. */
const STROKE = [
  [100, 100],
  [140, 120],
  [180, 110],
  [220, 140],
  [260, 130],
  [300, 150],
  [340, 140],
  [380, 160],
  [420, 150],
];

const strokeD = () =>
  STROKE.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x} ${y}`).join(" ");

describe("performErase", () => {
  it("splits a stroke into the runs outside the eraser", () => {
    const stroke = new Path(strokeD(), { fill: null });
    const objects = [stroke];
    const engine = makeEngine(objects, { x: 180, y: 110 });

    engine.performErase({});

    expect(objects).toHaveLength(2);
    expect(objects).not.toContain(stroke);
    // Erasing at the third vertex splits off the first two points; the rest
    // survives as one run.
    expect(scenePoints(objects[0])).toEqual([
      { x: 100, y: 100 },
      { x: 140, y: 120 },
    ]);
    expect(scenePoints(objects[1])).toEqual(
      STROKE.slice(4).map(([x, y]) => ({ x, y })),
    );
  });

  it("places rebuilt fragments where the original stroke was", () => {
    const stroke = new Path(strokeD(), { fill: null });
    const objects = [stroke];
    const engine = makeEngine(objects, { x: 180, y: 110 });

    engine.performErase({});

    // Regression: rebasing the path to 0,0 and passing left/top shifted every
    // fragment up-left by half its bbox (Fabric's origin is the object centre).
    for (const fragment of objects) {
      const m = fragment.calcTransformMatrix();
      expect(m[4]).not.toBe(0);
      for (const cmd of fragment.path) {
        const scene = toScene(fragment, cmd);
        expect(scene.x).toBeCloseTo(cmd[cmd.length - 2], 6);
        expect(scene.y).toBeCloseTo(cmd[cmd.length - 1], 6);
      }
    }
  });

  it("can partially erase a fragment it rebuilt earlier", () => {
    const stroke = new Path(strokeD(), { fill: null });
    const objects = [stroke];
    const engine = makeEngine(objects, { x: 180, y: 110 });
    engine.performErase({});

    const [leftRun, rightRun] = objects;
    expect(scenePoints(rightRun)).toHaveLength(5);

    // Second pass, over the middle of the rebuilt right-hand run.
    const secondPass = makeEngine(objects, { x: 340, y: 140 });
    secondPass.performErase({});

    expect(objects).toHaveLength(2);
    expect(objects).toContain(leftRun);
    expect(objects).not.toContain(rightRun);
    expect(scenePoints(objects[1])).toEqual([
      { x: 260, y: 130 },
      { x: 300, y: 150 },
    ]);
  });

  it("still erases a fragment on the second pass even after several passes", () => {
    const stroke = new Path(strokeD(), { fill: null });
    const objects = [stroke];
    makeEngine(objects, { x: 180, y: 110 }).performErase({});
    makeEngine(objects, { x: 340, y: 140 }).performErase({});

    const target = objects[1];
    const third = makeEngine(objects, { x: 300, y: 150 });
    third.performErase({});

    // Third generation fragment still responds, and is replaced rather than
    // left untouched.
    expect(objects).not.toContain(target);
    expect(objects).toHaveLength(1);
    expect(third.recordHistory).toHaveBeenCalled();
  });

  it("keeps the dashed pen style across a rebuild", () => {
    const stroke = new Path(strokeD(), { fill: null, strokeDashArray: [6, 6] });
    const objects = [stroke];
    const engine = makeEngine(objects, { x: 180, y: 110 });

    engine.performErase({});

    for (const fragment of objects) {
      expect(fragment.strokeDashArray).toEqual([6, 6]);
    }
  });

  it("leaves untouched strokes alone", () => {
    const stroke = new Path(strokeD(), { fill: null });
    const objects = [stroke];
    const engine = makeEngine(objects, { x: 700, y: 700 });

    engine.performErase({});

    expect(objects).toEqual([stroke]);
    expect(engine.recordHistory).not.toHaveBeenCalled();
  });

  it("partially erases a rotated stroke instead of deleting it whole", () => {
    const stroke = new Path(strokeD(), { fill: null });
    stroke.set({ angle: 30, originX: "center", originY: "center" });
    // Re-derive left/top so the rotation pivot is the stroke's centre.
    stroke.setCoords();
    const objects = [stroke];
    const engine = makeEngine(objects, { x: 260, y: 130 });
    engine.performErase({});

    // Partial erase produces fragments; whole-delete would leave zero objects.
    expect(objects.length).toBeGreaterThan(1);
    expect(objects).not.toContain(stroke);
  });

  it("preserves quadratic curves in surviving fragments", () => {
    const curved =
      "M 100 100 Q 130 60 160 100 Q 190 140 220 100 Q 250 60 280 100 Q 310 140 340 100 Q 370 60 400 100";
    const stroke = new Path(curved, { fill: null });
    const objects = [stroke];
    const engine = makeEngine(objects, { x: 250, y: 80 });
    engine.performErase({});

    const hasCurve = objects.some((o) =>
      o.path.some((cmd) => cmd[0] === "Q"),
    );
    expect(hasCurve).toBe(true);
    expect(objects.length).toBeGreaterThan(0);
  });
});

describe("erase history coalescing", () => {
  it("defers history until the gesture ends", () => {
    const objects = [new Path(strokeD(), { fill: null })];
    const engine = makeEngine(objects, { x: 180, y: 110 });
    engine.isErasing = true;

    engine.performErase({});
    engine.performErase({}); // a second pointermove tick in the same drag

    expect(engine.recordHistory).not.toHaveBeenCalled();

    engine.endEraseGesture();

    expect(engine.recordHistory).toHaveBeenCalledTimes(1);
    expect(engine.isErasing).toBe(false);
  });

  it("writes nothing when no erase actually happened", () => {
    const objects = [new Path(strokeD(), { fill: null })];
    const engine = makeEngine(objects, { x: 700, y: 700 });
    engine.isErasing = true;

    engine.performErase({});
    engine.endEraseGesture();

    expect(engine.recordHistory).not.toHaveBeenCalled();
  });

  it("records immediately for an erase outside a gesture", () => {
    const objects = [new Path(strokeD(), { fill: null })];
    const engine = makeEngine(objects, { x: 180, y: 110 });
    engine.isErasing = false;

    engine.performErase({});

    expect(engine.recordHistory).toHaveBeenCalledTimes(1);
  });

  it("flushes a pending entry only once", () => {
    const engine = makeEngine([], { x: 0, y: 0 });
    engine.isErasing = true;
    engine.eraseHistoryPending = true;

    engine.endEraseGesture();
    expect(engine.recordHistory).toHaveBeenCalledTimes(1);

    engine.endEraseGesture();
    expect(engine.recordHistory).toHaveBeenCalledTimes(1);
  });
});
