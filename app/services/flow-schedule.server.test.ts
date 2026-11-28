import { describe, expect, it } from "vitest";
import {
  calculateNextEmailAt,
  computeStaggerMinutes,
  nextScheduledSlot,
  SCHEDULE_HOUR_UTC,
} from "./consent.server";

describe("Mon/Thu Flow schedule", () => {
  it("picks the next Monday or Thursday after a given instant", () => {
    // Wednesday → Thursday same week
    const wed = new Date("2026-01-07T10:00:00.000Z");
    const slot = nextScheduledSlot({ after: wed });
    expect(slot.getUTCDay()).toBe(4);
    expect(slot.getUTCHours()).toBe(SCHEDULE_HOUR_UTC);
    expect(slot.toISOString()).toBe("2026-01-08T14:00:00.000Z");
  });

  it("skips the same UTC day after a successful send", () => {
    const thu = new Date("2026-01-08T09:00:00.000Z");
    const sameDay = nextScheduledSlot({ after: thu, skipSameUtcDay: false });
    expect(sameDay.toISOString()).toBe("2026-01-08T14:00:00.000Z");

    const next = nextScheduledSlot({ after: thu, skipSameUtcDay: true });
    expect(next.toISOString()).toBe("2026-01-12T14:00:00.000Z");
    expect(next.getUTCDay()).toBe(1);
  });

  it("does not push first-send stagger across multiple days", () => {
    const mins = computeStaggerMinutes(
      "shop",
      "gid://shopify/Customer/stagger",
      7,
    );
    expect(mins).toBeLessThan(4 * 60);

    const now = new Date("2026-01-05T10:00:00.000Z"); // Monday before slot
    const first = calculateNextEmailAt({
      shopId: "shop",
      shopifyCustomerGid: "gid://shopify/Customer/stagger",
      intervalDays: 7,
      now,
      staggerInitial: true,
    });
    // Still Monday or next scheduled day within a week — never +7 full days of hash
    const diffDays =
      (first.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeLessThan(7);
  });
});
