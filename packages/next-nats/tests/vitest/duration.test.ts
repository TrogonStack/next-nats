import { describe, expect, it } from "vitest";
import { Duration, duration } from "../../src/duration.js";

describe("Duration", () => {
  it.each([
    ["90s", 90_000_000_000],
    ["24h", 86_400_000_000_000],
    ["1h30m", 5_400_000_000_000],
    ["1.5s", 1_500_000_000],
    ["250ms", 250_000_000],
    ["10us", 10_000],
    ["5µs", 5_000],
    ["7ns", 7],
    ["2d", 172_800_000_000_000],
    ["1m30s500ms", 90_500_000_000],
    ["0", 0],
    [" 5s ", 5_000_000_000],
  ])("parses %s", (text, nanos) => {
    expect(Duration.parse(text).toNanos()).toBe(nanos);
  });

  it.each(["", "abc", "5", "5x", "-5s", "s5", "1h 30m", "1..5s", "5s!"])("rejects %j", (text) => {
    expect(() => Duration.parse(text)).toThrow(/Invalid duration/);
  });

  it("converts to millis and compares", () => {
    expect(Duration.parse("1500ms").toMillis()).toBe(1500);
    expect(Duration.parse("90s").equals(Duration.ofMillis(90_000))).toBe(true);
  });

  it("accepts durations, strings and milliseconds", () => {
    expect(duration("1s").toNanos()).toBe(1_000_000_000);
    expect(duration(1000).toNanos()).toBe(1_000_000_000);
    const d = Duration.parse("2s");
    expect(duration(d)).toBe(d);
  });

  it("rejects invalid numbers", () => {
    expect(() => Duration.ofMillis(-1)).toThrow();
    expect(() => Duration.ofMillis(Number.NaN)).toThrow();
    expect(() => Duration.ofNanos(1.5)).toThrow();
  });
});
