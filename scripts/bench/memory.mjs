/** Release build: pnpm --filter @tessera/desktop tauri build --no-bundle
 * pnpm bench:memory. NFR-04: at most 150 MB with 4 panes and at most 25 MB per extra pane.
 * On macOS the gate uses the physical footprint (Activity Monitor's Memory); RSS is reported too but also counts the
 * system frameworks every webview app maps (decision D-17). On Windows the working set is the gate.
 * macOS WebKit services can be reparented to launchd and are then absent: report this limitation.
 * Memory is sampled after prompt readiness, then after three real UI shortcut splits and four prompt marks.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { footprintBytes, launch, memory, metadata, ready, save, stop } from "./common.mjs";
console.log(metadata());
const app = await launch();
try {
  await ready(app);
  const one = memory(app.child.pid);
  const oneFootprint = footprintBytes(one.tree);
  await writeFile(join(app.dir, "four-panes"), "");
  await ready(app, 4);
  const four = memory(app.child.pid);
  const fourFootprint = footprintBytes(four.tree);
  const gate = (a, b) => ({ one: a ?? one.bytes, four: b ?? four.bytes });
  const measured = gate(oneFootprint, fourFootprint);
  const perExtra = (measured.four - measured.one) / 3 / 1000000;
  const result = {
    metric: oneFootprint === null ? "working set / RSS" : "physical footprint",
    one_pane_MB: measured.one / 1000000,
    four_panes_MB: measured.four / 1000000,
    MB_per_extra_pane: perExtra,
    rss_one_pane_MB: one.bytes / 1000000,
    rss_four_panes_MB: four.bytes / 1000000,
    pass: measured.four <= 150000000 && perExtra <= 25,
    evidence: app.dir,
  };
  await save("Memory", result);
  console.log(JSON.stringify({ ...result, one_tree: one.tree, four_tree: four.tree }));
} finally {
  await stop(app);
}
