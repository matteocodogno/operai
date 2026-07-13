/**
 * Unit tests for InProcessTicketStore (T3, specs/005-notification-center, ADR-0008).
 *
 * done when: "bun test proves … ticket mint→consume is single-use + expires".
 */

import { describe, it, expect } from "bun:test";
import { InProcessTicketStore } from "./ticketStore";

describe("InProcessTicketStore", () => {
  it("mint→consume: a freshly minted ticket resolves to the bound sub", () => {
    const store = new InProcessTicketStore();
    const ticket = store.mint("user-a");

    const sub = store.consume(ticket);

    expect(sub).toBe("user-a");
  });

  it("single-use: consuming the same ticket a second time returns undefined", () => {
    const store = new InProcessTicketStore();
    const ticket = store.mint("user-a");

    const first = store.consume(ticket);
    const second = store.consume(ticket);

    expect(first).toBe("user-a");
    expect(second).toBeUndefined();
  });

  it("unknown ticket → undefined", () => {
    const store = new InProcessTicketStore();
    expect(store.consume("never-minted")).toBeUndefined();
  });

  it("expired ticket → undefined (TTL enforced)", async () => {
    // Use a very short TTL so the test does not need to wait ~30s.
    const store = new InProcessTicketStore(10); // 10ms TTL
    const ticket = store.mint("user-a");

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(store.consume(ticket)).toBeUndefined();
  });

  it("expired ticket consume is also single-use — a second attempt still returns undefined", async () => {
    const store = new InProcessTicketStore(10);
    const ticket = store.mint("user-a");
    await new Promise((resolve) => setTimeout(resolve, 30));

    const first = store.consume(ticket);
    const second = store.consume(ticket);

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
  });

  it("tickets are bound to a sub — different mints for different subs resolve independently", () => {
    const store = new InProcessTicketStore();
    const ticketA = store.mint("user-a");
    const ticketB = store.mint("user-b");

    expect(store.consume(ticketB)).toBe("user-b");
    expect(store.consume(ticketA)).toBe("user-a");
  });

  it("mint produces distinct opaque tickets on repeated calls for the same sub", () => {
    const store = new InProcessTicketStore();
    const t1 = store.mint("user-a");
    const t2 = store.mint("user-a");

    expect(t1).not.toBe(t2);
    // Both remain independently consumable exactly once.
    expect(store.consume(t1)).toBe("user-a");
    expect(store.consume(t2)).toBe("user-a");
    expect(store.consume(t1)).toBeUndefined();
    expect(store.consume(t2)).toBeUndefined();
  });

  it("a not-yet-expired ticket well within TTL is still valid (no false-positive expiry)", async () => {
    const store = new InProcessTicketStore(30_000); // full 30s TTL
    const ticket = store.mint("user-a");

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(store.consume(ticket)).toBe("user-a");
  });
});
