// A polite live region for things a screen reader user would otherwise miss (a tab moved by keyboard).
import { useAppSelector } from "../store/hooks";

export function Announcer() {
  const announcement = useAppSelector((state) => state.ui.announcement);
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="announcer">
      {announcement && <span key={announcement.id}>{announcement.text}</span>}
    </div>
  );
}
