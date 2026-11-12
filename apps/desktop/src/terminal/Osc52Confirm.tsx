// "A program wants to copy N characters to the clipboard." (FR-08, `terminal.osc52_write = "ask"`): a small bar at
// the top of the pane with Deny (focused: a key typed by mistake picks the safe answer), Allow and Always allow.
import { Button, Icons, t } from "@tessera/ui";
import { useEffect, useRef } from "react";

export type Osc52Choice = "allow" | "deny" | "always";

export function Osc52Confirm({ count, onChoose }: { count: number; onChoose: (choice: Osc52Choice) => void }) {
  const deny = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    deny.current?.focus();
  }, []);
  return (
    <div
      role="alertdialog"
      aria-labelledby="osc52-message"
      data-osc52-confirm
      className="absolute inset-x-3 top-3 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-base text-fg shadow-popover"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onChoose("deny");
        }
      }}
    >
      <Icons.Clipboard size={16} className="shrink-0 text-muted" aria-hidden />
      <span id="osc52-message" className="min-w-0 flex-1">
        {t("osc52.ask", { count: count.toLocaleString() })}
      </span>
      <Button ref={deny} size="sm" onClick={() => onChoose("deny")}>
        {t("osc52.deny")}
      </Button>
      <Button size="sm" onClick={() => onChoose("always")}>
        {t("osc52.always")}
      </Button>
      <Button size="sm" variant="primary" onClick={() => onChoose("allow")}>
        {t("osc52.allow")}
      </Button>
    </div>
  );
}
