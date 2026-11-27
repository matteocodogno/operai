/**
 * The sliding-window limiter and the team windows (specs/20261126-teams T11; D13, D15; AC-5.6). An injected clock
 * throughout: no real sleeps.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  admitTeamRead,
  advanceTeamLimitersForTests,
  ATTACHABLE_TEAMS_CALLER_LIMIT,
  attachableTeamsLimiter,
  createSlidingWindowRateLimiter,
  resetTeamLimiters,
  TEAM_READ_PERSON_LIMIT,
  TEAM_READ_SERVICE_LIMIT,
  TEAM_READ_WINDOW_MS,
  teamReadPersonLimiter,
  teamReadServiceLimiter,
} from "./rateLimiter";

describe("createSlidingWindowRateLimiter", () => {
  it("admits `limit` attempts and refuses the next, with the time until the oldest ages out", () => {
    const limiter = createSlidingWindowRateLimiter({ limit: 2, windowMs: 1000 });
    expect(limiter.consume("a", 0).allowed).toBe(true);
    expect(limiter.consume("a", 100).allowed).toBe(true);
    expect(limiter.consume("a", 300)).toEqual({ allowed: false, retryAfterMs: 700 });
  });

  it("a refused consume records nothing: trying again never moves the retry time or extends the wait", () => {
    const limiter = createSlidingWindowRateLimiter({ limit: 1, windowMs: 1000 });
    limiter.consume("a", 0);
    expect(limiter.consume("a", 100).retryAfterMs).toBe(900);
    expect(limiter.consume("a", 900).retryAfterMs).toBe(100);
    // the first attempt left the window at 1000; the refusals in between did not delay that
    expect(limiter.consume("a", 1001).allowed).toBe(true);
  });

  it("keys are independent", () => {
    const limiter = createSlidingWindowRateLimiter({ limit: 1, windowMs: 1000 });
    expect(limiter.consume("a", 0).allowed).toBe(true);
    expect(limiter.consume("b", 0).allowed).toBe(true);
    expect(limiter.consume("a", 1).allowed).toBe(false);
  });

  it("`peek` reports what a consume would, and records nothing", () => {
    const limiter = createSlidingWindowRateLimiter({ limit: 2, windowMs: 1000 });
    for (let i = 0; i < 50; i++) expect(limiter.peek("a", 0)).toEqual({ allowed: true, retryAfterMs: 0 });
    // fifty peeks used nothing up: both consumes are still admitted
    expect(limiter.consume("a", 0).allowed).toBe(true);
    expect(limiter.consume("a", 10).allowed).toBe(true);
    expect(limiter.peek("a", 200)).toEqual({ allowed: false, retryAfterMs: 800 });
    // a refused peek records nothing either: the retry time is the one from the first admitted attempt
    expect(limiter.peek("a", 900).retryAfterMs).toBe(100);
    expect(limiter.peek("a", 1001).allowed).toBe(true);
  });

  it("`peek` of a key never seen is admitted and does not create it", () => {
    const limiter = createSlidingWindowRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 1 });
    limiter.consume("held", 0);
    // with the map full, a peek of a new key must not take the held key's slot nor the overflow's
    expect(limiter.peek("new", 0).allowed).toBe(true);
    expect(limiter.consume("held", 1).allowed).toBe(false);
  });

  it("`reset` forgets every key", () => {
    const limiter = createSlidingWindowRateLimiter({ limit: 1, windowMs: 1000 });
    limiter.consume("a", 0);
    limiter.reset();
    expect(limiter.consume("a", 1).allowed).toBe(true);
  });

  it("uses its `clock` when no time is passed", () => {
    let t = 0;
    const limiter = createSlidingWindowRateLimiter({ limit: 1, windowMs: 1000, clock: () => t });
    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(false);
    t = 1001;
    expect(limiter.consume("a").allowed).toBe(true);
  });
});

describe("the team windows (D13, D15)", () => {
  let warnSpy: ReturnType<typeof spyOn>;
  let warned: string[];
  beforeEach(() => {
    resetTeamLimiters();
    warned = [];
    warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warned.push(args.join(" ")));
  });
  afterEach(() => warnSpy.mockRestore());

  /** Spends the whole service window, 20 reads at a time by 120 different people, at `now`. */
  const spendService = (now: number) => {
    for (let i = 0; i < TEAM_READ_SERVICE_LIMIT / TEAM_READ_PERSON_LIMIT; i++) {
      for (let j = 0; j < TEAM_READ_PERSON_LIMIT; j++) expect(admitTeamRead(`p-${i}`, now).admitted).toBe(true);
    }
  };

  it("constants: 120 per person, 2 400 for the service, 10 minutes, and 120 for the attach search", () => {
    expect(TEAM_READ_PERSON_LIMIT).toBe(120);
    expect(TEAM_READ_SERVICE_LIMIT).toBe(2400);
    expect(TEAM_READ_WINDOW_MS).toBe(600_000);
    expect(ATTACHABLE_TEAMS_CALLER_LIMIT).toBe(120);
  });

  it("the attach limiter is a window of its own: spending it spends neither page-read window, nor the reverse", () => {
    expect(attachableTeamsLimiter).not.toBe(teamReadPersonLimiter);
    expect(attachableTeamsLimiter).not.toBe(teamReadServiceLimiter);
    expect(teamReadPersonLimiter).not.toBe(teamReadServiceLimiter);
    for (let i = 0; i < ATTACHABLE_TEAMS_CALLER_LIMIT; i++) expect(attachableTeamsLimiter.consume("p").allowed).toBe(true);
    expect(attachableTeamsLimiter.consume("p").allowed).toBe(false);
    expect(admitTeamRead("p")).toEqual({ admitted: true });
    resetTeamLimiters();
    for (let i = 0; i < TEAM_READ_PERSON_LIMIT; i++) admitTeamRead("p");
    expect(attachableTeamsLimiter.consume("p").allowed).toBe(true);
  });

  it("admits a person 120 reads in a window and refuses the 121st with the seconds left, rounded up", () => {
    for (let i = 0; i < 120; i++) expect(admitTeamRead("ada", i * 1000).admitted).toBe(true);
    // the oldest admitted read is at t=0 and the window is 600 s: 480.5 s left
    expect(admitTeamRead("ada", 119_500)).toEqual({ admitted: false, window: "person", retryAfterSeconds: 481 });
    // 479.999 s left
    expect(admitTeamRead("ada", 120_001)).toEqual({ admitted: false, window: "person", retryAfterSeconds: 480 });
  });

  it("the remainder is never 0 and never above 600", () => {
    for (let i = 0; i < 120; i++) admitTeamRead("ada", 0);
    expect(admitTeamRead("ada", 599_999.5)).toEqual({ admitted: false, window: "person", retryAfterSeconds: 1 });
    expect(admitTeamRead("ada", 0)).toEqual({ admitted: false, window: "person", retryAfterSeconds: 600 });
  });

  it("a refused read is not recorded: reloading never extends the wait, and the person is back when the oldest leaves", () => {
    for (let i = 0; i < 120; i++) admitTeamRead("ada", 0);
    for (let i = 0; i < 500; i++) expect(admitTeamRead("ada", 1000 + i).admitted).toBe(false);
    expect(admitTeamRead("ada", 600_001).admitted).toBe(true);
  });

  it("another person is unaffected by one person's limit", () => {
    for (let i = 0; i < 121; i++) admitTeamRead("ada", 0);
    expect(admitTeamRead("bob", 1)).toEqual({ admitted: true });
  });

  it("both or neither: a person refused by their own window spends nothing of the service's", () => {
    for (let i = 0; i < 120; i++) admitTeamRead("ada", 0);
    for (let i = 0; i < 1000; i++) expect(admitTeamRead("ada", 1).admitted).toBe(false);
    // the service saw ada's 120 admitted reads and nothing else: 2 280 more are admitted, the next is not
    for (let i = 0; i < TEAM_READ_SERVICE_LIMIT - 120; i++) expect(admitTeamRead(`user-${i}`, 2).admitted).toBe(true);
    expect(admitTeamRead("late", 3)).toEqual({ admitted: false, window: "service", retryAfterSeconds: null });
  });

  it("both or neither: a service refusal spends nothing of the person's, and says nothing about a limit of theirs", () => {
    spendService(0);
    expect(admitTeamRead("fresh", 1)).toEqual({ admitted: false, window: "service", retryAfterSeconds: null });
    expect(teamReadPersonLimiter.peek("fresh", 1)).toEqual({ allowed: true, retryAfterMs: 0 });
    // once the window has passed the person still has all 120
    for (let i = 0; i < 120; i++) expect(admitTeamRead("fresh", 600_001).admitted).toBe(true);
    expect(admitTeamRead("fresh", 600_002)).toMatchObject({ admitted: false, window: "person" });
  });

  it("a person over both limits is told it is theirs", () => {
    for (let i = 0; i < 120; i++) admitTeamRead("ada", 0);
    for (let i = 0; i < (TEAM_READ_SERVICE_LIMIT - 120) / TEAM_READ_PERSON_LIMIT; i++) {
      for (let j = 0; j < TEAM_READ_PERSON_LIMIT; j++) admitTeamRead(`p-${i}`, 0);
    }
    expect(admitTeamRead("ada", 1)).toMatchObject({ admitted: false, window: "person" });
  });

  it("logs a person's first refusal in a window, once, with the actor and the window and nothing else", () => {
    for (let i = 0; i < 120; i++) admitTeamRead("ada", 0);
    admitTeamRead("ada", 1);
    admitTeamRead("ada", 2);
    admitTeamRead("ada", 3);
    expect(warned).toEqual(["[teams] page-read limited actor=ada window=person"]);
    // a later window, a new line
    for (let i = 0; i < 120; i++) admitTeamRead("ada", 1_300_000);
    admitTeamRead("ada", 1_300_001);
    expect(warned).toHaveLength(2);
  });

  it("logs the service window's refusal per person too", () => {
    spendService(0);
    admitTeamRead("fresh", 1);
    admitTeamRead("fresh", 2);
    expect(warned).toEqual(["[teams] page-read limited actor=fresh window=service"]);
  });

  it("resetTeamLimiters resets every window; advanceTeamLimitersForTests moves their clock", () => {
    for (let i = 0; i < 121; i++) admitTeamRead("ada");
    for (let i = 0; i < ATTACHABLE_TEAMS_CALLER_LIMIT + 1; i++) attachableTeamsLimiter.consume("ada");
    expect(admitTeamRead("ada").admitted).toBe(false);
    advanceTeamLimitersForTests(TEAM_READ_WINDOW_MS + 1);
    expect(admitTeamRead("ada").admitted).toBe(true);
    expect(attachableTeamsLimiter.consume("ada").allowed).toBe(true);
    resetTeamLimiters();
    for (let i = 0; i < 121; i++) admitTeamRead("ada");
    resetTeamLimiters();
    expect(admitTeamRead("ada").admitted).toBe(true);
  });
});
