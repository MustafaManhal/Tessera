# Tessera website

A small static site (no build step): the download page, the privacy policy and the code signing policy.

- Download buttons read the latest GitHub release in the browser (`app.js`), so a new release shows up without a redeploy.
- Deploy on Vercel: import the repository, set **Root Directory** to `website`, framework preset **Other**, no build command.
- Preview locally: `npx serve website`.
