// Download buttons: ask GitHub for the latest release and link its installers. Nothing from the response is put in the
// page as HTML: text goes in with textContent, and a link is used only when it points at this repository's releases.
(() => {
  const REPO = "MustafaManhal/Tessera";
  const PREFIX = `https://github.com/${REPO}/releases/`;
  const grid = document.getElementById("dl-grid");
  const main = document.getElementById("dl-main");
  const mainSub = document.getElementById("dl-main-sub");
  const meta = document.getElementById("dl-meta");

  const say = document.getElementById("say");
  const audio = document.getElementById("say-audio");
  if (say && audio) {
    say.addEventListener("click", () => {
      audio.currentTime = 0;
      audio.play().catch(() => {
        say.textContent = "No audio";
      });
    });
  }

  function os() {
    const hint =
      (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || "";
    if (/win/i.test(hint)) return "windows";
    if (/mac|iphone|ipad/i.test(hint)) return "mac";
    return "other";
  }

  function size(bytes) {
    return bytes > 1048576 ? `${(bytes / 1048576).toFixed(0)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function pick(assets) {
    const safe = assets.filter(
      (a) => typeof a.browser_download_url === "string" && a.browser_download_url.startsWith(PREFIX),
    );
    const find = (re) => safe.find((a) => re.test(a.name));
    return {
      // One universal .dmg covers Apple silicon and Intel; separate per-architecture ones are used if a release has them.
      macUniversal: find(/universal.*\.dmg$/i),
      macArm: find(/(aarch64|arm64).*\.dmg$/i),
      macIntel: find(/(x64|x86_64|amd64).*\.dmg$/i),
      winExe: find(/(x64|x86_64|amd64).*setup\.exe$/i) || find(/setup\.exe$/i),
      winArm: find(/(arm64|aarch64).*setup\.exe$/i),
      winMsi: find(/\.msi$/i),
    };
  }

  function addButton(label, sub, asset, primary) {
    const a = document.createElement("a");
    a.className = primary ? "btn primary" : "btn";
    a.href = asset.browser_download_url;
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = label;
    const s = document.createElement("span");
    s.className = "s";
    s.textContent = `${sub} · ${size(asset.size)}`;
    a.append(t, s);
    return a;
  }

  function show(release) {
    const files = pick(release.assets || []);
    const mine = os();
    const buttons = [];
    if (files.macUniversal)
      buttons.push({
        key: "mac",
        el: addButton("Download for macOS", "Apple silicon and Intel (.dmg)", files.macUniversal, false),
      });
    else {
      if (files.macArm)
        buttons.push({ key: "mac", el: addButton("Download for macOS", "Apple silicon (.dmg)", files.macArm, false) });
      if (files.macIntel && files.macIntel !== files.macArm)
        buttons.push({ key: "mac", el: addButton("macOS, Intel", "Intel Macs (.dmg)", files.macIntel, false) });
    }
    if (files.winExe)
      buttons.push({ key: "windows", el: addButton("Download for Windows", "64-bit installer (.exe)", files.winExe, false) });
    else if (files.winMsi)
      buttons.push({ key: "windows", el: addButton("Download for Windows", "Installer (.msi)", files.winMsi, false) });
    if (files.winArm && files.winArm !== files.winExe)
      buttons.push({ key: "windows", el: addButton("Windows on Arm", "Arm64 installer (.exe)", files.winArm, false) });
    if (buttons.length === 0) return soon();
    buttons.sort((x, y) => Number(y.key === mine) - Number(x.key === mine));
    buttons[0].el.classList.add("primary");
    grid.replaceChildren(...buttons.map((b) => b.el));
    const date = release.published_at
      ? new Date(release.published_at).toLocaleDateString(undefined, { dateStyle: "long" })
      : "";
    meta.textContent = `Version ${String(release.tag_name || "").replace(/^v/, "")}${date ? ` · ${date}` : ""} · `;
    const notes = document.createElement("a");
    notes.href =
      typeof release.html_url === "string" && release.html_url.startsWith(PREFIX)
        ? release.html_url
        : `${PREFIX}latest`;
    notes.textContent = "Release notes";
    meta.append(notes);
  }

  function soon() {
    main.setAttribute("aria-disabled", "false");
    mainSub.textContent = "The first release is coming soon. Follow it on GitHub.";
    meta.textContent = "";
  }

  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then(show)
    .catch(soon);
})();
