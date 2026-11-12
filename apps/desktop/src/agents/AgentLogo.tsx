// The agent's logo where a name or an icon used to be: the brand mark when Tessera has one, else a lettered badge.
// `agent` is the definition id ("claude"); `name` is the display name the letters come from. The logo is decorative: the
// name is always printed next to it.
import { cn } from "@tessera/ui";
import { LOGOS } from "./logos";

const BADGE_COLORS = ["#4f6df5", "#0f8a7a", "#b45309", "#a21caf", "#be123c", "#2563a8", "#4d7c0f", "#6d28d9"];

function badgeColor(key: string): string {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return BADGE_COLORS[hash % BADGE_COLORS.length] ?? "#4f6df5";
}

function letters(name: string): string {
  const words = name.split(/[\s_-]+/).filter(Boolean);
  const first = words[0]?.charAt(0) ?? "?";
  return (words.length > 1 ? first + (words[1]?.charAt(0) ?? "") : (words[0]?.slice(0, 2) ?? first)).toUpperCase();
}

/** Whether a brand mark exists for this agent id (the badge is used otherwise). */
export function hasLogo(agent: string): boolean {
  return agent in LOGOS;
}

export function AgentLogo({
  agent,
  name,
  size = 16,
  className,
}: {
  agent: string;
  name?: string;
  size?: number;
  className?: string;
}) {
  const logo = LOGOS[agent];
  if (logo) {
    return (
      <svg
        data-agent-logo={agent}
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill={logo.color ?? "currentColor"}
        aria-hidden
        className={cn("shrink-0", !logo.color && "text-fg", className)}
      >
        {logo.paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    );
  }
  const text = letters(name ?? agent);
  return (
    <span
      data-agent-logo={agent}
      aria-hidden
      style={{
        width: size,
        height: size,
        fontSize: Math.max(7, Math.round(size * (text.length > 1 ? 0.42 : 0.55))),
        backgroundColor: badgeColor(agent),
        color: "#ffffff",
      }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md font-semibold leading-none",
        className,
      )}
    >
      {text}
    </span>
  );
}
