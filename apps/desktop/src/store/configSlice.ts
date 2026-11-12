// The last config the Rust side reported (`settings_get`, `config:changed`) and the latest `config:error`, for the
// settings screen. The terminal's own `settings.terminal` slice follows it through `configApplied` (settingsSlice).
import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { ConfigDiagnostic, ConfigObject } from "../settings/client";

export interface ConfigState {
  /** null until the first `settings_get` answers (or when there is no backend). */
  values: ConfigObject | null;
  /** The current problem with config.toml; cleared by the next good `config:changed`. */
  diagnostic: ConfigDiagnostic | null;
}

const initialState: ConfigState = { values: null, diagnostic: null };

export const configSlice = createSlice({
  name: "config",
  initialState,
  reducers: {
    /** A good config arrived: keep it and clear the error banner. */
    configApplied: (state, action: PayloadAction<ConfigObject>) => {
      state.values = action.payload;
      state.diagnostic = null;
    },
    configDiagnostic: (state, action: PayloadAction<ConfigDiagnostic>) => {
      state.diagnostic = action.payload;
    },
    dismissDiagnostic: (state) => {
      state.diagnostic = null;
    },
  },
});

export const { configApplied, configDiagnostic, dismissDiagnostic } = configSlice.actions;
