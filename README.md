# Alexandria 6G Ecosystem Map

A public, no-login map of who is shaping 6G around Alexandria, Virginia. It has three views: a geographic map, a network diagram and an association membership table.

## How it fits together

- **Notion is the backend.** The "Alexandria 6G Ecosystem (map backend)" page holds two databases, Ecosystem and Connections. Your team adds and edits entries there.
- **This repo is the public site.** GitHub Pages serves `index.html`, which reads `data/ecosystem.json`.
- **A nightly GitHub Action** (`.github/workflows/sync-notion.yml`) exports Notion to `data/ecosystem.json`.

## What stays private

The sync exports only rows with **Public on map** ticked, and only these columns: name, short name, category, region, description, role, organisation, address, latitude, longitude, location precision and sources.

These columns are never exported: Relationship status, Relationship owner, Last contact, Private notes, Email, LinkedIn and Phone.

New contacts are private by default. People are never pinned at a personal location. They appear under their organisation.

## One-time setup

1. **Turn on Pages.** Go to Settings → Pages → Deploy from a branch → `main` / root.
2. **Create a Notion integration.** Go to notion.so/my-integrations → New integration (internal, read content only) and copy the secret.
3. **Share the backend page with it.** Open the backend page in Notion → ••• → Connections → add your integration.
4. **Add the secret to GitHub.** Go to Settings → Secrets and variables → Actions → New secret. Name it `NOTION_TOKEN` and paste the secret.
5. **Run the sync.** Go to Actions → "Sync map from Notion" → Run workflow. After that it runs nightly.

## Adding contacts

- **One at a time:** use the "Add a contact" form view on the Ecosystem database.
- **In bulk:** go to Ecosystem → ••• → Merge with CSV.
- **Linking people:** add a row in Connections with a type such as Research together, Contract or award, or Membership. The map can also link people automatically when their organisations share an association.
