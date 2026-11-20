/** Parse screenshot CLI arguments without starting a browser. */
export function parseShotArgs(args) {
  const options = { url: "http://localhost:1421/?gallery", name: "gallery", out: "shots" };
  for (let i = 0; i < args.length; i++) {
    const key = args[i]?.slice(2);
    if (!args[i]?.startsWith("--") || !Object.hasOwn(options, key)) throw new Error(`Unknown option: ${args[i]}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    options[key] = value;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(options.name)) throw new Error("Name must be a filename-safe slug");
  const url = new URL(options.url, "http://localhost:1421");
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("URL must use HTTP or HTTPS");
  return { ...options, url: url.href };
}
