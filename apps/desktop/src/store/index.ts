// The app store (Redux Toolkit, D-09): the layout slice (the pure layout reducer), UI state, a settings stub, and the
// listener middleware for side effects. Redux DevTools in dev builds only; RTK's serializable and immutability checks
// run in dev (they also prove the layout reducer never mutates its input).
import { reportingMiddleware } from "../diagnostics/reporting";
import { configureStore, createListenerMiddleware, type ThunkAction, type UnknownAction } from "@reduxjs/toolkit";
import type { LayoutEnv } from "../layout";
import { agentSessionsSlice } from "../agents/sessionsSlice";
import { sshSlice } from "../ssh/sshSlice";
import { attentionSlice } from "./attentionSlice";
import { configSlice } from "./configSlice";
import { createLayoutSlice, INITIAL_CWD, layoutSlice } from "./layoutSlice";
import { addAppListeners } from "./listeners";
import { projectsSlice } from "./projectsSlice";
import { settingsSlice } from "./settingsSlice";
import { themesSlice } from "./themesSlice";
import { uiSlice } from "./uiSlice";

export interface AppStoreOptions {
  /** Id generator for the layout (tests inject a predictable one). */
  env?: LayoutEnv;
  /** Start with one terminal in the home folder (tests written for a window that has a tab). The app starts empty. */
  homeTab?: boolean;
}

export function createAppStore({ env, homeTab = false }: AppStoreOptions = {}) {
  const listener = createListenerMiddleware();
  const layoutReducer = env ? createLayoutSlice(env).reducer : layoutSlice.reducer;
  const store = configureStore({
    reducer: {
      layout: layoutReducer,
      ui: uiSlice.reducer,
      settings: settingsSlice.reducer,
      attention: attentionSlice.reducer,
      config: configSlice.reducer,
      projects: projectsSlice.reducer,
      themes: themesSlice.reducer,
      agentSessions: agentSessionsSlice.reducer,
      ssh: sshSlice.reducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().prepend(listener.middleware).concat(reportingMiddleware),
    devTools: import.meta.env.DEV,
  });
  addAppListeners(listener.startListening.withTypes<RootState, AppDispatch>());
  if (homeTab) store.dispatch(layoutSlice.actions.apply({ type: "tab/new", cwd: INITIAL_CWD }, "none"));
  return store;
}

export type AppStore = ReturnType<typeof createAppStore>;
export type RootState = ReturnType<AppStore["getState"]>;
export type AppDispatch = AppStore["dispatch"];
export type AppThunk<Result = void> = ThunkAction<Result, RootState, unknown, UnknownAction>;

/** The app's one store. */
export const store = createAppStore();
