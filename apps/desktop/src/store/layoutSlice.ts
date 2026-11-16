// The layout slice: Redux around the pure layout reducer from packages/term, unchanged (D-09). One action,
// `layout/apply`, carries a `LayoutAction`; the reducer does all the work. The slice never touches Immer's draft: it
// hands the reducer the original state and returns the reducer's result.
import { createSlice, original, type PayloadAction } from "@reduxjs/toolkit";
import { createLayout, type LayoutAction, type LayoutEnv, type LayoutState, layoutReducer } from "../layout";

/** Where the first pane starts until real sessions report their cwd (M1.1). */
export const INITIAL_CWD = "~";

/**
 * Where keyboard focus goes after the change (the listener middleware moves it): into the focused pane, onto the
 * selected tab in the tab strip, or nowhere. Without it, the listener picks by the kind of change.
 */
export type FocusTarget = "pane" | "tab" | "none";

export function createLayoutSlice(env?: LayoutEnv) {
  return createSlice({
    name: "layout",
    initialState: (): LayoutState => createLayout(INITIAL_CWD, env),
    reducers: {
      apply: {
        reducer: (state, action: PayloadAction<LayoutAction, string, { focus?: FocusTarget } | undefined>) =>
          layoutReducer(original(state) as LayoutState, action.payload, env),
        prepare: (change: LayoutAction, focus?: FocusTarget) => ({
          payload: change,
          meta: focus ? { focus } : undefined,
        }),
      },
    },
  });
}

export const layoutSlice = createLayoutSlice();

/** The Redux action for a layout change: `dispatch(layout({ type: "tab/new" }))`, optionally with a focus target. */
export const layout = layoutSlice.actions.apply;
