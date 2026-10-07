import { DASHBOARD_CARD_IDS, resolveLayout } from "./dashboard-layout.js";

describe("resolveLayout", () => {
  it("defaults to every card, donut style", () => {
    expect(resolveLayout(null)).toEqual({ order: [...DASHBOARD_CARD_IDS], hidden: [], mixStyle: "donut" });
  });

  it("keeps the saved order, appends new cards and drops duplicates", () => {
    const layout = resolveLayout({ order: ["recent", "stats", "recent"], hidden: ["rail"], mixStyle: "bubble" });
    expect(layout.order.slice(0, 2)).toEqual(["recent", "stats"]);
    expect(layout.order).toHaveLength(DASHBOARD_CARD_IDS.length);
    expect(layout).toMatchObject({ hidden: ["rail"], mixStyle: "bubble" });
  });

  it("ignores a layout with unknown cards", () => {
    expect(resolveLayout({ order: ["nope"], hidden: [] }).order).toEqual([...DASHBOARD_CARD_IDS]);
  });
});
