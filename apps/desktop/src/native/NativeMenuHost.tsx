import { useEffect, useMemo } from "react";
import { createMenuClient, startNativeMenu } from "./menu";

export function NativeMenuHost() {
  const client = useMemo(createMenuClient, []);
  useEffect(() => startNativeMenu(client), [client]);
  return null;
}
