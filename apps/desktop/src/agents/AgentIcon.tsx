// The lucide icon a definition names (`icon` in the TOML). An unknown name falls back to a generic bot.
import { cn, Icons, type LucideIcon } from "@tessera/ui";

const AGENT_ICONS: Record<string, LucideIcon> = {
  Sparkles: Icons.Sparkles,
  Terminal: Icons.Terminal,
  Gem: Icons.Gem,
  SquareTerminal: Icons.SquareTerminal,
  MousePointerClick: Icons.MousePointerClick,
  Zap: Icons.Zap,
  Moon: Icons.Moon,
  GitPullRequest: Icons.GitPullRequest,
  GitBranch: Icons.GitBranch,
  Bot: Icons.Bot,
  Code: Icons.Code,
  MessageSquare: Icons.MessageSquare,
  MousePointer: Icons.MousePointer,
  // lucide has no brand icons; the GitHub Copilot definition asks for "github".
  Github: Icons.GitPullRequest,
};

/** Definitions name icons in kebab or lower case ("sparkles", "square-terminal"); the map uses lucide's names. */
function lucideName(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function AgentIcon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  const Icon = AGENT_ICONS[name] ?? AGENT_ICONS[lucideName(name)] ?? Icons.Bot;
  return <Icon size={size} className={cn("shrink-0 text-muted", className)} aria-hidden />;
}
