import { useEffect } from "react";
import { setTerminal } from "../store/settingsSlice";
import { useAppDispatch } from "../store/hooks";
import { reportNativeCommandError } from "./errors";
import { readSecureKeyboardEntry } from "./secureKeyboardEntry";

export function SecureKeyboardEntryHost() {
  const dispatch = useAppDispatch();
  useEffect(() => {
    let active = true;
    void readSecureKeyboardEntry()
      .then((enabled) => {
        if (active && enabled !== null) dispatch(setTerminal({ secureKeyboardEntry: enabled }));
      })
      .catch((error: unknown) => reportNativeCommandError("native.secureKeyboardReadFailed", error));
    return () => {
      active = false;
    };
  }, [dispatch]);
  return null;
}
