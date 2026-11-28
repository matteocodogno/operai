import { describe, expect, it } from "bun:test";
import { MEASURE_MARGIN_DIVISOR, MEASURE_MARGIN_FLOOR_MS, durationAfterMeasure } from "./measuredDuration";

// The rule that decides whether the duration a recorded or uploaded meeting holds is replaced by the one `prepare_audio`
// measured from its audio (specs/20261112-meeting-hours AC-3.8, AC-3.10; plan § The measured duration, D-P6, A42; ADR
// 20261124-a-duration-a-client-reports-is-replaced-by-the-one-the-server-measures-when-they-differ-by-more-than-the-larger-of-30-seconds-and-10-percent).
// Pure, integers only: the vectors below are the plan's, with the edge on each side of both margins.

const MIN = 60_000;
const HOUR = 60 * MIN;
/** mm:ss.mmm as milliseconds. */
const at = (minutes: number, seconds = 0, millis = 0) => minutes * MIN + seconds * 1000 + millis;

describe("the margin's constants (A42)", () => {
  it("is 30 seconds as a floor and one tenth of the held duration", () => {
    expect(MEASURE_MARGIN_FLOOR_MS).toBe(30_000);
    expect(MEASURE_MARGIN_DIVISOR).toBe(10);
  });
});

describe("durationAfterMeasure: no duration held (AC-1.1, AC-3.2)", () => {
  it("takes the measured one", () => {
    expect(durationAfterMeasure(null, at(37))).toBe(at(37));
  });

  it("takes a measured 0 too (hours-api reads 0 as not known, D-P4)", () => {
    expect(durationAfterMeasure(null, 0)).toBe(0);
  });
});

describe("durationAfterMeasure: the audio contradicts the held duration (AC-3.8)", () => {
  it("held 0 and measured 20 min: the measured one (the percentage of nothing is nothing, so the floor decides)", () => {
    expect(durationAfterMeasure(0, at(20))).toBe(at(20));
  });

  it("held 3 h and measured 12 s: the measured one, a claim far too long", () => {
    expect(durationAfterMeasure(3 * HOUR, 12_000)).toBe(12_000);
  });

  it("held 2 h and measured 1 h: the measured one, shorter than the held", () => {
    expect(durationAfterMeasure(2 * HOUR, HOUR)).toBe(HOUR);
  });

  it("held 10 min and measured 3 h: the measured one, a claim far too short (both directions are checked)", () => {
    expect(durationAfterMeasure(at(10), 3 * HOUR)).toBe(3 * HOUR);
  });

  describe("the 30 s floor binds on a short meeting", () => {
    it("held 4:00 and measured 4:30 is exactly 30 s: not more than the floor, so held", () => {
      expect(durationAfterMeasure(at(4), at(4, 30))).toBe(at(4));
    });
    it("held 4:00 and measured 4:31: the measured one", () => {
      expect(durationAfterMeasure(at(4), at(4, 31))).toBe(at(4, 31));
    });
    it("held 4:00 and measured 3:29: the measured one, shorter", () => {
      expect(durationAfterMeasure(at(4), at(3, 29))).toBe(at(3, 29));
    });
    it("held 4:00 and measured 3:30 is exactly 30 s shorter: held", () => {
      expect(durationAfterMeasure(at(4), at(3, 30))).toBe(at(4));
    });
    it("held 0 and measured 10 s: held (10 s is not more than the floor)", () => {
      expect(durationAfterMeasure(0, 10_000)).toBe(0);
    });
  });

  describe("the 10 % binds on a long meeting", () => {
    it("held 60:00 and measured 66:00 is exactly 10 %: not more, so held", () => {
      expect(durationAfterMeasure(at(60), at(66))).toBe(at(60));
    });
    it("held 60:00 and measured 66:00.001: the measured one", () => {
      expect(durationAfterMeasure(at(60), at(66, 0, 1))).toBe(at(66, 0, 1));
    });
    it("held 60:00 and measured 54:00 is exactly 10 % shorter: held", () => {
      expect(durationAfterMeasure(at(60), at(54))).toBe(at(60));
    });
    it("held 60:00 and measured 53:59.999: the measured one", () => {
      expect(durationAfterMeasure(at(60), at(53, 59, 999))).toBe(at(53, 59, 999));
    });
  });
});

describe("durationAfterMeasure: within the margin the held duration stands (AC-3.10)", () => {
  it("held 10:00 and measured 10:20: held", () => {
    expect(durationAfterMeasure(at(10), at(10, 20))).toBe(at(10));
  });

  it("held 10:00 and measured 9:40: held", () => {
    expect(durationAfterMeasure(at(10), at(9, 40))).toBe(at(10));
  });

  it("the same figure: held", () => {
    expect(durationAfterMeasure(at(25), at(25))).toBe(at(25));
  });

  it("held 44:00 and measured 46:00 stays held, though the two would round to 30 and 60 min (AC-3.10)", () => {
    expect(durationAfterMeasure(at(44), at(46))).toBe(at(44));
  });

  it("held 46:00 and measured 44:00 stays held, the other direction", () => {
    expect(durationAfterMeasure(at(46), at(44))).toBe(at(46));
  });
});
