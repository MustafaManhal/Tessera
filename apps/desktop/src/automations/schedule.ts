/** Plain-language names for the common cron expressions; anything else is shown as written. */
export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [minute = "", hour = "", dom = "", month = "", dow = ""] = parts;
  const two = (value: string) => value.padStart(2, "0");
  const time = /^\d+$/.test(minute) && /^\d+$/.test(hour) ? `${two(hour)}:${two(minute)}` : null;
  if (expr.trim() === "* * * * *") return "Every minute";
  const every = /^\*\/(\d+)$/.exec(minute);
  if (every && hour === "*" && dom === "*" && month === "*" && dow === "*") return `Every ${every[1]} minutes`;
  if (minute === "0" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "Every hour";
  if (time && dom === "*" && month === "*") {
    if (dow === "*") return `Every day at ${time}`;
    if (dow === "1-5") return `Weekdays at ${time}`;
    if (/^[0-7]$/.test(dow)) {
      const names = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
      return `${names[Number(dow)]} at ${time}`;
    }
  }
  return expr;
}

/** "in 5 min", "in 3 h", "Nov 12 09:00" style text for a future time. */
export function untilText(at: number, now: number): string {
  const seconds = at - now;
  if (seconds <= 0) return "now";
  if (seconds < 90) return "in a minute";
  if (seconds < 3600) return `in ${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `in ${Math.round(seconds / 3600)} h`;
  return new Date(at * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
