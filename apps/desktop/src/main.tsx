import "./styles.css";
import "./assets/fonts/fonts.css";
import { getPlatform, setToastErrorReport, type ToastOptions, UIProvider } from "@tessera/ui";
import { notifications } from "./notify";
import React, { type ComponentType, lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { Provider } from "react-redux";
import App from "./App";
import { SettingsClientProvider, createSettingsClient } from "./settings/provider";
import { store } from "./store";
import { setSettingsOpen, setSettingsPage } from "./store/uiSlice";
import { createProjectsClient } from "./projects/service";
import { createAgentsClient, setAgentsClient } from "./agents/service";
import { createBoardClient, setBoardClient } from "./board/service";
import { createAutomationsClient, setAutomationsClient } from "./automations/service";
import { createIssuesClient, setIssuesClient } from "./issues/service";
import { benchMark } from "./native/benchmark";
import { applyAccessibilityPrefs } from "./accessibility/prefs";
import { buildErrorReport } from "./diagnostics/report";
import { createFeedbackClient, setFeedbackClient } from "./feedback/service";
import { createUpdatesClient, setUpdatesClient } from "./updates/service";
import { createUsageClient, setUsageClient } from "./usage/service";
import { createCliClient, setCliClient } from "./cli/service";
import { createLayoutStore, startSessionRestore } from "./restore/service";
import { setProjectsClient } from "./projects/service";
import { createPtyClient, PtyClientProvider } from "./terminal/ptyClient";
import { isNativeRuntime } from "./native/runtime";
import { createTauriLayoutBindings } from "./restore/ipc";
import type { LayoutBindings } from "./restore/store";
import { windowClient } from "./native/windows";
import { setWindowLabel } from "./native/quickTerminal";
import { reportNativeCommandError } from "./native/errors";

declare global {
  interface Window {
    /** Dev builds only: the store, for tests and debugging. */
    __tesseraStore?: typeof store;
    /** Dev builds only: shows a toast, for tests. */
    __tesseraToast?: (options: ToastOptions) => void;
  }
}
if (import.meta.env.DEV) {
  window.__tesseraStore = store;
  window.__tesseraToast = (options) => notifications().toastNow(options);
}

benchMark("main_start");
applyAccessibilityPrefs();

// Platform-specific CSS (the terminal font size on Windows) keys off this attribute.
document.documentElement.dataset.platform = getPlatform();

// The component gallery (`/?gallery`) exists only in dev builds; production builds drop it.
let Root: ComponentType = App;
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("gallery")) {
  Root = lazy(() => import("./dev/Gallery"));
}

// Dev-only deep link for screenshots and audits: `/?settings=agents` opens Settings on that section.
if (import.meta.env.DEV && Root === App) {
  const settingsPage = new URLSearchParams(window.location.search).get("settings");
  if (settingsPage) {
    store.dispatch(setSettingsPage(settingsPage));
    store.dispatch(setSettingsOpen(true));
  }
}

setProjectsClient(createProjectsClient());
setAgentsClient(createAgentsClient());
setUsageClient(createUsageClient());
setBoardClient(createBoardClient());
setIssuesClient(createIssuesClient());
setAutomationsClient(createAutomationsClient());
setUpdatesClient(createUpdatesClient());
setFeedbackClient(createFeedbackClient());
setToastErrorReport((options) => () => buildErrorReport(options.title, options.description ?? ""));
setCliClient(createCliClient());

const layoutBindings: LayoutBindings | null = isNativeRuntime() ? createTauriLayoutBindings() : null;

function render(): void {
  benchMark("render");
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Provider store={store}>
        <PtyClientProvider client={createPtyClient()}>
          <SettingsClientProvider client={createSettingsClient()}>
            <UIProvider>
              <Suspense fallback={null}>
                <Root />
              </Suspense>
            </UIProvider>
          </SettingsClientProvider>
        </PtyClientProvider>
      </Provider>
    </React.StrictMode>,
  );
}

// The saved layout is loaded before any pane mounts (a pane spawns its shell when it mounts). Never blocks for long.
if (Root === App) {
  const layoutStore = createLayoutStore(layoutBindings);
  void windowClient()
    .currentId()
    .then((windowId) => {
      setWindowLabel(windowId);
      return startSessionRestore(store, layoutStore, windowId);
    })
    .then(render, (error: unknown) => {
      reportNativeCommandError("native.windowFailed", error);
      render();
    });
} else render();
