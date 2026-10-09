/**
 * Unit tests for pdf/importModel.js
 *
 * Run with: node tests/unit/importModel.test.mjs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  stripVolatileSources,
  hydrateCanvasJson,
  compactCanvasJson,
  legacyCandidatesFromDecomposed,
  summarizeObjects,
  IMPORT_OBJECT_PROPS,
  PLACEHOLDER_IMAGE_SRC,
  PDF_IMPORT_SCALE,
} from "../../src/pdf/importModel.js";

describe("importModel", () => {
  describe("stripVolatileSources", () => {
    it("replaces blob: URLs with placeholder for images with assetId", () => {
      const canvasData = {
        objects: [
          {
            type: "image",
            omniType: "image",
            assetId: "asset-123",
            src: "blob:https://example.com/abc",
          },
        ],
      };

      const result = stripVolatileSources(canvasData);
      expect(result.objects[0].src).toBe(PLACEHOLDER_IMAGE_SRC);
      expect(result.objects[0].assetId).toBe("asset-123");
    });

    it("replaces blob: URLs with placeholder for images without assetId", () => {
      const canvasData = {
        objects: [
          {
            type: "image",
            src: "blob:https://example.com/abc",
          },
        ],
      };

      const result = stripVolatileSources(canvasData);
      expect(result.objects[0].src).toBe(PLACEHOLDER_IMAGE_SRC);
    });

    it("does not modify non-image objects", () => {
      const canvasData = {
        objects: [
          {
            type: "path",
            omniType: "vector",
            pathData: "M 0 0 L 10 10",
          },
        ],
      };

      const result = stripVolatileSources(canvasData);
      expect(result.objects[0].type).toBe("path");
      expect(result.objects[0].pathData).toBe("M 0 0 L 10 10");
    });

    it("recursively processes group children", () => {
      const canvasData = {
        objects: [
          {
            type: "group",
            objects: [
              {
                type: "image",
                omniType: "image",
                assetId: "asset-123",
                src: "blob:https://example.com/abc",
              },
            ],
          },
        ],
      };

      const result = stripVolatileSources(canvasData);
      expect(result.objects[0].objects[0].src).toBe(PLACEHOLDER_IMAGE_SRC);
    });

    it("returns input unchanged for non-plain-objects", () => {
      expect(stripVolatileSources(null)).toBeNull();
      expect(stripVolatileSources("string")).toBe("string");
      expect(stripVolatileSources(123)).toBe(123);
      expect(stripVolatileSources([])).toEqual([]);
    });
  });

  describe("legacyCandidatesFromDecomposed", () => {
    it("converts legacy textObjects to new format", () => {
      const decomposed = {
        textObjects: [
          {
            text: "Hello",
            left: 100,
            top: 200,
            fontSize: 14,
            fontFamily: "Arial",
            fill: "#ff0000",
            width: 50,
            height: 20,
          },
        ],
      };

      const result = legacyCandidatesFromDecomposed(decomposed);
      expect(result).toHaveLength(1);
      expect(result[0].omniType).toBe("text");
      expect(result[0].text).toBe("Hello");
      expect(result[0].left).toBe(100);
      expect(result[0].top).toBe(200);
      expect(result[0].fontSize).toBe(14);
      expect(result[0].fontFamily).toBe("Arial");
      expect(result[0].fill).toBe("#ff0000");
      expect(result[0].importConfidence).toBe(0.6);
    });

    it("converts legacy pathObjects to new format", () => {
      const decomposed = {
        pathObjects: [
          {
            pathData: "M 0 0 L 10 10",
            stroke: "#000000",
            strokeWidth: 2,
            fill: "transparent",
          },
        ],
      };

      const result = legacyCandidatesFromDecomposed(decomposed);
      expect(result).toHaveLength(1);
      expect(result[0].omniType).toBe("vector");
      expect(result[0].pathData).toBe("M 0 0 L 10 10");
      expect(result[0].stroke).toBe("#000000");
      expect(result[0].strokeWidth).toBe(2);
      expect(result[0].importConfidence).toBe(0.6);
    });

    it("converts legacy imageObjects to new format", () => {
      const decomposed = {
        imageObjects: [
          {
            assetId: "asset-456",
            left: 50,
            top: 60,
            width: 100,
            height: 80,
          },
        ],
      };

      const result = legacyCandidatesFromDecomposed(decomposed);
      expect(result).toHaveLength(1);
      expect(result[0].omniType).toBe("image");
      expect(result[0].assetId).toBe("asset-456");
      expect(result[0].left).toBe(50);
      expect(result[0].top).toBe(60);
      expect(result[0].importConfidence).toBe(0.6);
    });

    it("handles empty decomposed data", () => {
      expect(legacyCandidatesFromDecomposed({})).toEqual([]);
      expect(legacyCandidatesFromDecomposed(null)).toEqual([]);
      expect(legacyCandidatesFromDecomposed(undefined)).toEqual([]);
    });

    it("generates unique omniId for each object", () => {
      const decomposed = {
        textObjects: [
          { text: "A", left: 0, top: 0, fontSize: 12, width: 10, height: 10 },
          { text: "B", left: 0, top: 0, fontSize: 12, width: 10, height: 10 },
        ],
      };

      const result = legacyCandidatesFromDecomposed(decomposed);
      expect(result[0].omniId).not.toBe(result[1].omniId);
      expect(result[0].omniId).toMatch(/^legacy-\d+$/);
    });
  });

  describe("summarizeObjects", () => {
    it("counts objects by type", () => {
      const objects = [
        { omniType: "text" },
        { omniType: "text" },
        { omniType: "vector" },
        { omniType: "vectorGroup" },
        { omniType: "image" },
        { omniType: "image" },
        { omniType: "image" },
      ];

      const result = summarizeObjects(objects);
      expect(result.textObjects).toBe(2);
      expect(result.vectorGroups).toBe(2); // vector + vectorGroup
      expect(result.imageObjects).toBe(3);
    });

    it("handles empty array", () => {
      const result = summarizeObjects([]);
      expect(result.textObjects).toBe(0);
      expect(result.vectorGroups).toBe(0);
      expect(result.imageObjects).toBe(0);
    });

    it("handles non-array input", () => {
      const result = summarizeObjects(null);
      expect(result.textObjects).toBe(0);
      expect(result.vectorGroups).toBe(0);
      expect(result.imageObjects).toBe(0);
    });
  });

  describe("constants", () => {
    it("exports expected constants", () => {
      expect(PDF_IMPORT_SCALE).toBe(1.333333);
      expect(IMPORT_OBJECT_PROPS).toContain("omniId");
      expect(IMPORT_OBJECT_PROPS).toContain("omniType");
      expect(IMPORT_OBJECT_PROPS).toContain("assetId");
      expect(PLACEHOLDER_IMAGE_SRC).toContain("data:image/png;base64,");
    });
  });
});