import { PanePlaceholder } from "./shell/pane/PanePlaceholder";
import { isQuickWindow } from "./native/quickTerminal";
import { QuickShell } from "./shell/QuickShell";
import { Shell } from "./shell/Shell";
import { useNativeDrops } from "./terminal/drop";
import { usePtyClient } from "./terminal/ptyClient";
import { PaneRouter } from "./terminal/PaneRouter";

// Panes run a real terminal when a PtyClient is available (the fake shell in a browser, the Rust PTY host in Tauri once
// it lands); otherwise, and with `?placeholder`, they show the placeholder.
function App() {
  const client = usePtyClient();
  useNativeDrops();
  const content = client ? PaneRouter : PanePlaceholder;
  return isQuickWindow() ? <QuickShell paneContent={content} /> : <Shell paneContent={content} />;
}

export default App;
