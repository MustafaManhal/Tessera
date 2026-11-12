// Themes outside the config: imported schemes, favourites (both kept app-local, see themes/storage.ts), and the theme the
// picker is previewing on the real terminals right now (null: none).
import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { Theme } from "../themes/model";
import { loadFavourites, loadImported, saveFavourites, saveImported } from "../themes/storage";

export interface ThemesState {
  imported: Theme[];
  favourites: string[];
  preview: Theme | null;
}

export const themesSlice = createSlice({
  name: "themes",
  initialState: (): ThemesState => ({ imported: loadImported(), favourites: loadFavourites(), preview: null }),
  reducers: {
    /** Adds imported themes; one with the same id is replaced. */
    themesImported: (state, action: PayloadAction<Theme[]>) => {
      for (const theme of action.payload) {
        const at = state.imported.findIndex((existing) => existing.id === theme.id);
        if (at >= 0) state.imported[at] = theme;
        else state.imported.push(theme);
      }
      saveImported(state.imported);
    },
    themeRemoved: (state, action: PayloadAction<string>) => {
      state.imported = state.imported.filter((theme) => theme.id !== action.payload);
      state.favourites = state.favourites.filter((id) => id !== action.payload);
      saveImported(state.imported);
      saveFavourites(state.favourites);
    },
    favouriteToggled: (state, action: PayloadAction<string>) => {
      state.favourites = state.favourites.includes(action.payload)
        ? state.favourites.filter((id) => id !== action.payload)
        : [...state.favourites, action.payload];
      saveFavourites(state.favourites);
    },
    previewSet: (state, action: PayloadAction<Theme | null>) => {
      state.preview = action.payload;
    },
  },
});

export const { themesImported, themeRemoved, favouriteToggled, previewSet } = themesSlice.actions;
