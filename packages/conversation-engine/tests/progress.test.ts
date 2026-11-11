import { describe, expect, test } from "vitest";
import { overallFraction, progressBar } from "../src/progress";

describe("progressBar", () => {
  test("empty at 0 and full at 1", () => {
    expect(progressBar(0, 10)).toBe("░".repeat(10));
    expect(progressBar(1, 10)).toBe("▓".repeat(10));
  });

  test("half full at 0.5", () => {
    expect(progressBar(0.5, 10)).toBe("▓".repeat(5) + "░".repeat(5));
  });

  test("clamps out-of-range fractions", () => {
    expect(progressBar(-1, 8)).toBe("░".repeat(8));
    expect(progressBar(2, 8)).toBe("▓".repeat(8));
  });
});

describe("overallFraction", () => {
  test("combines finished chunks with progress inside the current one", () => {
    expect(overallFraction(1, 4, 0.5)).toBeCloseTo(0.375);
    expect(overallFraction(0, 2, 0)).toBe(0);
    expect(overallFraction(2, 2, 0)).toBe(1);
  });

  test("clamps within-chunk progress", () => {
    expect(overallFraction(0, 2, 5)).toBeCloseTo(0.5);
  });
});
