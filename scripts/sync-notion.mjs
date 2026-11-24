// Merges the PUBLIC part of the Notion backend into data/ecosystem.json.
//
// Privacy rules:
// - Only rows with "Public on map" ticked are published, and only the whitelisted
//   columns below. Private columns (Relationship status, owner, notes, last contact,
//   email, LinkedIn, phone, priority) are never written to the output.
// - A row that exists in Notion but is NOT public is removed from the map, with its links.
// - People never carry their own coordinates. They are shown at their organisation.
//
// Merge rules (so map-only data is never lost):
// - Existing map entries are updated from Notion. An empty Notion field never blanks a map field.
// - Extra map-only fields (hub, chal, units, noscore) are kept.
// - Entries that are only in the map file, and not in Notion at all, are kept.
// - Notion links are added or updated. Links are never deleted by the sync, except when
//   one end has been made private.
// - Safety stop: if a run would remove more than MAX_REMOVALS entries, it stops and changes nothing.
//
// Env: NOTION_TOKEN (required), ECOSYSTEM_DB, CONNECTIONS_DB, MAX_REMOVALS (optional)
import { readFile, writeFile } from "node:fs/promises";

const TOKEN = process.env.NOTION_TOKEN;
const ECOSYSTEM_DB = process.env.ECOSYSTEM_DB || "93b1c87ef8ea492b97fed1844204216b";
const CONNECTIONS_DB = process.env.CONNECTIONS_DB || "8d1dfe6058de43b7bdeaa22597fb2e43";
const MAX_REMOVALS = Number(process.env.MAX_REMOVALS || 10);
const OUT = new URL("../data/ecosystem.json", import.meta.url);
if (!TOKEN) { console.error("NOTION_TOKEN is not set"); process.exit(1); }

async function queryAll(dbId, isPublic) {
  const rows = []; let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      body: JSON.stringify({ page_size: 100, start_cursor: cursor, filter: { property: "Public on map", checkbox: { equals: isPublic } } }),
    });
    if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
    const j = await res.json(); rows.push(...j.results); cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return rows;
}
const text = p => (p?.title || p?.rich_text || []).map(t => t.plain_text).join("").trim();
const sel = p => p?.select?.name || "";
const num = p => (typeof p?.number === "number" ? p.number : null);
const rel = p => (p?.relation || []).map(r => r.id.replace(/-/g, ""));
const url = p => p?.url || "";
const pid = pg => pg.id.replace(/-/g, "");
const slug = (s, id) => (s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item") + "-" + id.slice(0, 4);
const norm = s => (s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

// Notion connection types -> map connection types
const TYPE_MAP = {
  "Partnership / project": "Testbed / Trial / Consortium project",
  "Research together": "Joint R&D / Co-publication",
  "Contract or award": "Grant / Contract / Award",
};
const CATEGORY_MAP = { "Programmes & testbeds": "Programs & testbeds" };

const prev = JSON.parse(await readFile(OUT, "utf8"));
const byId = new Map(prev.nodes.map(n => [n.id, n]));
const byName = new Map(prev.nodes.map(n => [norm(n.name), n.id]));

// Resolve a Notion row to a map id: Map ID column, else an existing entry with the same name, else a new slug
const mapIdOf = pg => {
  const p = pg.properties; const mid = text(p["Map ID"]);
  if (mid) return mid;
  return byName.get(norm(text(p["Name"]))) || slug(text(p["Name"]), pid(pg));
};

const pub = await queryAll(ECOSYSTEM_DB, true);
const priv = await queryAll(ECOSYSTEM_DB, false);
const idOf = new Map(); // notion page id -> map id (public rows only)
for (const pg of pub) idOf.set(pid(pg), mapIdOf(pg));
// Only the Map ID and Name of private rows are used, to take them off the map
const privateIds = new Set(priv.map(mapIdOf).filter(id => ![...idOf.values()].includes(id)));

const nodes = new Map(prev.nodes.map(n => [n.id, { ...n }]));
let added = 0, updated = 0;
for (const pg of pub) {
  const p = pg.properties; const id = idOf.get(pid(pg));
  const name = text(p["Name"]); if (!name) continue;
  const org = rel(p["Organisation"]).map(x => idOf.get(x)).find(Boolean) || null; // only public orgs resolve
  // WHITELIST: add a field here only if it is safe to publish
  const fresh = {
    name, short: text(p["Short name"]),
    category: CATEGORY_MAP[sel(p["Category"])] || sel(p["Category"]) || "Person",
    region: sel(p["Region"]), description: text(p["Description"]), role: text(p["Role"]), org,
    address: text(p["Address"]), lat: num(p["Latitude"]), lng: num(p["Longitude"]), precision: sel(p["Location precision"]),
    sources: text(p["Sources"]).split(/\s+/).filter(s => /^https?:\/\//.test(s)),
    website: url(p["Website"]),
  };
  const cur = nodes.get(id);
  if (!cur) {
    nodes.set(id, { id, ...fresh, region: fresh.region || "Rest of US & global" }); added++;
  } else {
    const before = JSON.stringify(cur);
    for (const [k, v] of Object.entries(fresh)) {
      const empty = v === null || v === "" || (Array.isArray(v) && v.length === 0);
      if (empty) continue;
      if (k === "sources") cur.sources = [...new Set([...(cur.sources || []), ...v])];
      else cur[k] = v;
    }
    if (JSON.stringify(cur) !== before) updated++;
  }
}
// Take private rows off the map
const removed = [...privateIds].filter(id => nodes.has(id));
if (removed.length > MAX_REMOVALS) {
  console.error(`Safety stop: this run would remove ${removed.length} entries (limit ${MAX_REMOVALS}): ${removed.slice(0, 20).join(", ")}`);
  console.error("Nothing was changed. Check the 'Public on map' ticks in Notion, or raise MAX_REMOVALS for one run.");
  process.exit(1);
}
for (const id of removed) nodes.delete(id);
// People never carry their own coordinates
for (const n of nodes.values()) if (n.category === "Person") { n.lat = null; n.lng = null; n.address = ""; }

// Links: keep existing ones whose ends are still on the map, then add or update from Notion
const key = e => `${e.from}|${e.to}|${e.type}`;
const edges = new Map(prev.edges.filter(e => nodes.has(e.from) && nodes.has(e.to)).map(e => [key(e), { ...e }]));
const conns = await queryAll(CONNECTIONS_DB, true);
let linksAdded = 0;
for (const pg of conns) {
  const p = pg.properties;
  const from = idOf.get(rel(p["From"])[0]), to = idOf.get(rel(p["To"])[0]);
  if (!from || !to || !nodes.has(from) || !nodes.has(to)) continue; // one end is private or missing
  const type = TYPE_MAP[sel(p["Type"])] || sel(p["Type"]) || "Testbed / Trial / Consortium project";
  const e = { from, to, type, label: text(p["Label"]), source: url(p["Source URL"]) };
  const cur = edges.get(key(e));
  if (!cur) { edges.set(key(e), e); linksAdded++; }
  else { if (e.label) cur.label = e.label; if (e.source) cur.source = e.source; }
}
// People with an Organisation but no Role link still get linked
for (const n of nodes.values()) {
  if (n.org && nodes.has(n.org) && ![...edges.values()].some(e => e.from === n.id && e.to === n.org)) {
    const e = { from: n.id, to: n.org, type: "Role", label: n.role || "Works here", source: (n.sources || [])[0] || "" };
    edges.set(key(e), e); linksAdded++;
  }
}

// Keep the existing order and append new entries, so changes stay easy to review
const order = prev.nodes.map(n => n.id).filter(id => nodes.has(id));
for (const id of nodes.keys()) if (!order.includes(id)) order.push(id);
const outNodes = order.map(id => nodes.get(id));
const outEdges = [...edges.values()];
const same = JSON.stringify({ n: prev.nodes, e: prev.edges }) === JSON.stringify({ n: outNodes, e: outEdges });
if (same) { console.log("No public changes."); process.exit(0); }
await writeFile(OUT, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), nodes: outNodes, edges: outEdges }, null, 1) + "\n");
console.log(`Added ${added}, updated ${updated}, removed ${removed.length} entries (${removed.join(", ") || "none"}). Added ${linksAdded} links.`);
