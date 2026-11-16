# Tessera website

A small static site (no build step): the download page, the privacy policy and the code signing policy.

- Download buttons read the latest GitHub release in the browser (`app.js`), so a new release shows up without a redeploy.
- Deploy on Vercel: import the repository, set **Root Directory** to `website`, framework preset **Other**, no build command.
- Preview locally: `npx serve website`.

## Downloads come from GitHub, not from this site
`app.js` asks the GitHub API for the latest release and links the installers by their `github.com/.../releases/download/...`
address, and it only uses links that start with this repository's releases URL. The installers themselves are never
stored on or proxied through Vercel; this site is a few small static files, so downloads cost it nothing.
