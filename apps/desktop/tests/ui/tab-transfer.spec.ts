import { expect, test } from "@playwright/test";
import { fakeLog, openTerminal, run } from "./terminal-helpers";

test("an acknowledged tab move unmounts its source pane without killing the shell", async ({ page }) => {
  await openTerminal(page);
  await run(page, "echo before-move");
  await expect(page.locator(".xterm-rows")).toContainText("before-move");

  await page.evaluate(async () => {
    const modulePath = "/src/native/windows.ts";
    const { setWindowClient, windowClient } = (await import(modulePath)) as typeof import("../../src/native/windows");
    type WindowClient = ReturnType<typeof windowClient>;
    let acknowledged: Parameters<WindowClient["onAcknowledged"]>[0] | undefined;
    const shell = window.__tesseraFakePty;
    if (!shell) throw new Error("Fake PTY unavailable");
    setWindowClient({
      ...windowClient(),
      create: async () => "receiver",
      currentId: async () => "main",
      onAcknowledged: async (listener) => {
        acknowledged = listener;
        return () => {
          acknowledged = undefined;
        };
      },
      transfer: async (_from, to, json) => {
        const message = JSON.parse(json);
        if (message.operation !== "offer") return;
        const payload = JSON.parse(message.tabJson);
        const [pane] = Object.values(payload.sessions) as { sessionId?: string }[];
        const id = pane?.sessionId;
        if (!id) throw new Error("Offer omitted the running session");
        await shell.attach(id, (event) => {
          if (event.type === "data") void shell.ack(id, event.bytes.length);
        });
        acknowledged?.({ id: message.id, from: to, ok: true });
      },
    });
  });

  await page.getByRole("button", { name: "Window", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move tab to new window" }).click();
  await expect(page.locator(".xterm")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: /Notifications/ }).getByText(/Moved .* to another window/),
  ).toBeVisible();
  expect((await fakeLog(page)).kills).toEqual([]);
  const alive = await page.evaluate(async () => {
    const shell = window.__tesseraFakePty;
    if (!shell) return false;
    const sessionId = shell.log.writes.at(-1)?.session;
    if (!sessionId) return false;
    await shell.write(sessionId, new TextEncoder().encode("echo after-move\r"));
    return true;
  });
  expect(alive).toBe(true);
});
