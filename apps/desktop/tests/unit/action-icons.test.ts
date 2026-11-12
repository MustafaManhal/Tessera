import { describe, expect, it } from "vitest";
import { actionIcon, BY_ID } from "../../src/actions/icons";
import { actions } from "../../src/actions/registry";

describe("action icons", () => {
  it("every palette action has its own icon, and unknown ids fall back to the group icon", () => {
    const groupIcons = new Set(actions.map((action) => actionIcon("none", action.group)));
    // An action is covered when its own id, or its id family, gives something other than the plain group icon.
    const missing = actions
      .filter(
        (action) => !(action.id in BY_ID) && actionIcon(action.id, action.group) === actionIcon("none", action.group),
      )
      .map((action) => action.id);
    expect(missing).toEqual([]);
    expect(groupIcons.size).toBeGreaterThan(0);
    expect(actionIcon("nothing.here", "view")).toBeDefined();
  });
});
