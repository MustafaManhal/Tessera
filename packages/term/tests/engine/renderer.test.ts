import { describe, expect, it } from "vitest";
import { RendererController, type RendererLease } from "../../src/engine/renderer";

/** Counts live WebGL contexts the way a page would. */
function contexts() {
  let live = 0;
  let created = 0;
  const create = (): RendererLease => {
    live += 1;
    created += 1;
    let disposed = false;
    return {
      dispose: () => {
        if (!disposed) live -= 1;
        disposed = true;
      },
    };
  };
  return { create, live: () => live, created: () => created };
}

describe("RendererController", () => {
  it("holds a context only while mounted, wanted and visible", () => {
    const gl = contexts();
    const controller = new RendererController({ create: gl.create });
    expect(gl.live()).toBe(0);
    controller.mount();
    expect(gl.live()).toBe(1);
    controller.setVisible(false);
    expect(gl.live()).toBe(0);
    controller.setVisible(true);
    expect(gl.live()).toBe(1);
    controller.setWanted(false);
    expect(gl.live()).toBe(0);
    controller.setWanted(true);
    controller.dispose();
    expect(gl.live()).toBe(0);
  });

  it("20 hidden panes hold no contexts; showing one takes exactly one", () => {
    const gl = contexts();
    const panes = Array.from({ length: 21 }, () => new RendererController({ create: gl.create }));
    panes.forEach((pane, index) => {
      if (index > 0) pane.setVisible(false);
      pane.mount();
    });
    expect(gl.live()).toBe(1);
    panes[0]?.setVisible(false);
    panes[7]?.setVisible(true);
    expect(gl.live()).toBe(1);
    for (const pane of panes) pane.setVisible(false);
    expect(gl.live()).toBe(0);
  });

  it("falls back on context loss and retries on focus or when shown again", () => {
    const gl = contexts();
    const leases: RendererLease[] = [];
    const controller = new RendererController({
      create: () => {
        const lease = gl.create();
        leases.push(lease);
        return lease;
      },
    });
    controller.mount();
    controller.contextLost(leases[0] as RendererLease);
    expect(controller.active).toBe(false);
    expect(gl.live()).toBe(0);
    controller.retry();
    expect(controller.active).toBe(true);
    controller.contextLost(leases[1] as RendererLease);
    controller.setVisible(false);
    controller.setVisible(true);
    expect(gl.live()).toBe(1);
    // A stale lease is ignored.
    controller.contextLost(leases[0] as RendererLease);
    expect(controller.active).toBe(true);
  });

  it("stays on the DOM renderer when WebGL cannot be created", () => {
    const controller = new RendererController({ create: () => null });
    controller.mount();
    expect(controller.active).toBe(false);
    controller.rebuild();
    expect(controller.active).toBe(false);
  });
});
