import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  beginTaskBudget,
  remainingMs,
  clampMs,
  __resetTaskBudgetForTest,
} from "./deadline.js";

describe("deadline budget", () => {
  beforeEach(() => {
    __resetTaskBudgetForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetTaskBudgetForTest();
  });

  it("remainingMs is Infinity when beginTaskBudget was never called", () => {
    expect(remainingMs()).toBe(Number.POSITIVE_INFINITY);
  });

  it("clampMs passes the desired timeout through when there is no budget", () => {
    expect(clampMs(25_000)).toBe(25_000);
  });

  it("beginTaskBudget reserves the safety margin off the top", () => {
    beginTaskBudget(60); // 60s - 8s safety = 52s
    expect(remainingMs()).toBe(52_000);
  });

  it("remainingMs shrinks with elapsed time and floors at 0", () => {
    beginTaskBudget(60);
    vi.advanceTimersByTime(30_000);
    expect(remainingMs()).toBe(22_000);
    vi.advanceTimersByTime(60_000);
    expect(remainingMs()).toBe(0);
  });

  it("clampMs takes the smaller of desired and remaining", () => {
    beginTaskBudget(60);
    vi.advanceTimersByTime(30_000); // 22s left
    expect(clampMs(25_000)).toBe(22_000);
    expect(clampMs(10_000)).toBe(10_000);
  });

  it("clampMs never goes below the floor, even with the budget exhausted", () => {
    beginTaskBudget(10); // 2s budget after safety
    vi.advanceTimersByTime(5_000);
    expect(remainingMs()).toBe(0);
    expect(clampMs(25_000)).toBe(3_000);
    expect(clampMs(25_000, 1_000)).toBe(1_000);
  });

  it("a custom safety margin is honored", () => {
    beginTaskBudget(30, 2_000);
    expect(remainingMs()).toBe(28_000);
  });

  it("re-stamping the budget replaces the previous one", () => {
    beginTaskBudget(10);
    vi.advanceTimersByTime(5_000);
    beginTaskBudget(60);
    expect(remainingMs()).toBe(52_000);
  });
});
