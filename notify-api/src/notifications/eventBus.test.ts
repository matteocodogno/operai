/**
 * Unit tests for InProcessEventBus (T3, specs/005-notification-center).
 *
 * done when: "bun test proves publish→subscriber delivery and ticket mint→consume
 * is single-use + expires" — this file covers the publish→subscriber half;
 * ticketStore.test.ts covers the ticket half.
 */

import { describe, it, expect } from "bun:test";
import { InProcessEventBus, type NotifyEvent } from "./eventBus";

const sampleNotification: NotifyEvent = {
  type: "notification",
  data: {
    id: "notif-1",
    title: "Export finished",
    body: "Your XLSX export is ready.",
    severity: "success",
    originApp: "estimai",
    toastWorthy: true,
    readAt: null,
    createdAt: new Date().toISOString(),
  },
};

describe("InProcessEventBus", () => {
  it("publish→subscribe delivery: a subscriber for sub receives an event published to that sub", () => {
    const bus = new InProcessEventBus();
    const received: NotifyEvent[] = [];

    bus.subscribe("user-a", (event) => received.push(event));
    bus.publish("user-a", sampleNotification);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(sampleNotification);
  });

  it("fan-out: two subscribers for the SAME sub both receive the event (T7 done-when: two connections, one sub)", () => {
    const bus = new InProcessEventBus();
    const receivedA: NotifyEvent[] = [];
    const receivedB: NotifyEvent[] = [];

    bus.subscribe("user-a", (event) => receivedA.push(event));
    bus.subscribe("user-a", (event) => receivedB.push(event));
    bus.publish("user-a", sampleNotification);

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(1);
  });

  it("isolation: a subscriber for a DIFFERENT sub does not receive the event (AC-6.2)", () => {
    const bus = new InProcessEventBus();
    const receivedA: NotifyEvent[] = [];
    const receivedB: NotifyEvent[] = [];

    bus.subscribe("user-a", (event) => receivedA.push(event));
    bus.subscribe("user-b", (event) => receivedB.push(event));
    bus.publish("user-a", sampleNotification);

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(0);
  });

  it("publish with no subscribers for that sub is a no-op (does not throw)", () => {
    const bus = new InProcessEventBus();
    expect(() => bus.publish("nobody-listening", sampleNotification)).not.toThrow();
  });

  it("unread-reset event type is delivered like notification events", () => {
    const bus = new InProcessEventBus();
    const received: NotifyEvent[] = [];
    bus.subscribe("user-a", (event) => received.push(event));

    bus.publish("user-a", { type: "unread-reset", data: { count: 0 } });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: "unread-reset", data: { count: 0 } });
  });

  it("unsubscribe stops further delivery to that listener", () => {
    const bus = new InProcessEventBus();
    const received: NotifyEvent[] = [];
    const unsubscribe = bus.subscribe("user-a", (event) => received.push(event));

    bus.publish("user-a", sampleNotification);
    unsubscribe();
    bus.publish("user-a", sampleNotification);

    expect(received).toHaveLength(1); // only the first publish was received
  });

  it("unsubscribing one of two listeners leaves the other receiving events", () => {
    const bus = new InProcessEventBus();
    const receivedA: NotifyEvent[] = [];
    const receivedB: NotifyEvent[] = [];

    const unsubA = bus.subscribe("user-a", (event) => receivedA.push(event));
    bus.subscribe("user-a", (event) => receivedB.push(event));

    unsubA();
    bus.publish("user-a", sampleNotification);

    expect(receivedA).toHaveLength(0);
    expect(receivedB).toHaveLength(1);
  });

  it("connectionCount() reflects total listeners across all subs, updated on subscribe/unsubscribe", () => {
    const bus = new InProcessEventBus();
    expect(bus.connectionCount()).toBe(0);

    const unsubA1 = bus.subscribe("user-a", () => {});
    expect(bus.connectionCount()).toBe(1);

    bus.subscribe("user-a", () => {});
    expect(bus.connectionCount()).toBe(2);

    const unsubB = bus.subscribe("user-b", () => {});
    expect(bus.connectionCount()).toBe(3);

    unsubA1();
    expect(bus.connectionCount()).toBe(2);

    unsubB();
    expect(bus.connectionCount()).toBe(1);
  });

  it("a listener that unsubscribes itself synchronously during dispatch does not corrupt iteration", () => {
    // Regression guard for the Array.from() snapshot in publish() — without it,
    // mutating the Set mid-for-of could skip or crash on the next listener.
    const bus = new InProcessEventBus();
    const receivedC: NotifyEvent[] = [];

    let unsubA: () => void = () => {};
    unsubA = bus.subscribe("user-a", () => {
      unsubA();
    });
    bus.subscribe("user-a", (event) => receivedC.push(event));

    expect(() => bus.publish("user-a", sampleNotification)).not.toThrow();
    expect(receivedC).toHaveLength(1);
  });
});
