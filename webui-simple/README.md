# Simple page

A plain web page for qBittorrent, made for screen readers first. It is served
as qBittorrent's alternative WebUI at `/`, and the full (accessibility-fork)
interface from `src/webui/www` stays available at `/full.html`.

- `#/` lists torrents under collapsible headings (Problems, Downloading,
  Seeding, Stopped). Each line is the name, what it is doing, and speeds only
  when something is moving.
- `#/t/<hash>` is one torrent: a status sentence, Stop/Start (Try again for
  errors) and Remove, the useful facts, and files, trackers and peers behind
  disclosures. Removing a MyAnonamouse torrent that qBittorrent says has seeded
  for less than 72 hours shows an advisory first.
- `#/add` adds torrents from magnet links, web addresses or files.

Vanilla JavaScript, no build step. It talks to the WebUI API on the same
origin and only ever renders torrent data with `textContent`.

`deploy-webui.sh` assembles the deploy tree (the fork's `private/` and
`public/`, its `index.html` renamed to `full.html`, this page as `index.html`
with content-hash versions stamped into its asset URLs) and copies it into
the container's alternative-WebUI folder without restarting qBittorrent.
`./deploy-webui.sh --assemble-only DIR` builds the same tree for testing.
