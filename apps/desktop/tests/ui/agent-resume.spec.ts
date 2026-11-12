import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { mockTauri } from "./tauri-mock";
import { openTerminal } from "./terminal-helpers";

// The status engine end to end (brief 31): sidebar pills and the latest message from agent sessions, driven
// through the fake client's session changes (the observer's own throttling is unit-tested).

// Screenshots go to TESSERA_SHOTS_DIR (the lead points it at the brief's shots folder), else the system temp folder.
const SHOTS = process.env.TESSERA_SHOTS_DIR ?? join(tmpdir(), "tessera-shots", "34");

const tree = (page: Page) => page.getByRole("tree", { name: "Projects and tasks" });

async function demoReady(page: Page) {
  await openTerminal(page, "demo&renderer=dom");
  await expect(tree(page).getByRole("treeitem", { name: /Dark mode/ })).toBeVisible();
}

async function newTaskWithAgent(page: Page, name: string, agentId: string) {
  await page.keyboard.press("Control+Alt+Shift+N");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  await dialog.locator(`[data-agent-chip="${agentId}"]`).click();
  await dialog.getByRole("textbox", { name: "Task name" }).fill(name);
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toHaveCount(0);
}

/** The task's agent session id, once its PTY attach landed (attach resets the status to working). */
async function sessionId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const client = window.__tesseraAgents;
    if (!client) throw new Error("no fake agents client");
    const deadline = Date.now() + 10_000;
    for (;;) {
      const session = (await client.agentSessionsList(null)).find((s) => s.task_id !== null);
      if (session?.pane_session_id) return session.id;
      if (Date.now() > deadline) throw new Error("agent session never attached");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
}

async function setStatus(page: Page, id: string, status: string, message: string | null) {
  await page.evaluate(
    ({ id, status, message }) => {
      window.__tesseraAgents?.setSessionStatus(id, status as never, message);
    },
    { id, status, message },
  );
}

test.beforeEach(async ({ page }) => {
  await mockTauri(page);
});

test("resume requires an exited session and captured ID and relaunches in the same slot", async ({ page }) => {
  await demoReady(page);
  await newTaskWithAgent(page, "Resume probe", "claude");
  const id = await sessionId(page);
  const header = page.locator("[data-agent-header]").first();
  await expect(header.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
  await setStatus(page, id, "exited", null);
  await expect(header.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
  await page.evaluate((id) => window.__tesseraAgents?.setExternalSessionId(id, "fixture-vendor-id"), id);
  await expect(header.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const [width, height] of [
      [1280, 800],
      [900, 600],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: join(SHOTS, `resume-${theme}-${width}.png`) });
    }
  }
  const count = await page.locator("[data-agent-header]").count();
  await header.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.locator("[data-agent-header]")).toHaveCount(count);
  await expect
    .poll(async () =>
      page.evaluate(async () =>
        (await window.__tesseraAgents?.agentSessionsList(null))?.some(
          (s) =>
            s.id !== "" &&
            s.external_session_id === "fixture-vendor-id" &&
            !!s.pane_session_id &&
            s.status !== "exited",
        ),
      ),
    )
    .toBe(true);
});

test("resume explains unsupported errors inline", async ({ page }) => {
  await demoReady(page);
  await newTaskWithAgent(page, "Resume error", "claude");
  const id = await sessionId(page);
  await setStatus(page, id, "exited", null);
  await page.evaluate((id) => {
    const client = window.__tesseraAgents;
    if (!client) throw Error("missing client");
    client.setExternalSessionId(id, "vendor-id");
    client.agentResume = async () => {
      throw { code: "agent.resume_unsupported", message: "This session cannot be resumed." };
    };
  }, id);
  const header = page.locator("[data-agent-header]").first();
  await header.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(header.getByRole("alert")).toHaveText("This session cannot be resumed.");
});

test("an unsupported agent template hides Resume even with a captured ID", async ({ page }) => {
  await demoReady(page);
  await page.evaluate(() => {
    const client = window.__tesseraAgents;
    if (!client) throw Error("missing client");
    const catalog = client.agentCatalog.bind(client);
    client.agentCatalog = async (rescan) => (await catalog(rescan)).map((row) => ({ ...row, supports_resume: false }));
  });
  await newTaskWithAgent(page, "Unsupported resume", "claude");
  const id = await sessionId(page);
  await setStatus(page, id, "exited", null);
  await page.evaluate((id) => window.__tesseraAgents?.setExternalSessionId(id, "vendor-id"), id);
  await expect(page.locator("[data-agent-header]").getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
});
