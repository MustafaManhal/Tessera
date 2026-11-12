// The "Connect to SSH host" picker's open state.
import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export const sshSlice = createSlice({
  name: "ssh",
  initialState: { pickerOpen: false },
  reducers: {
    setSshPicker: (state, action: PayloadAction<boolean>) => {
      state.pickerOpen = action.payload;
    },
  },
});

export const { setSshPicker } = sshSlice.actions;
