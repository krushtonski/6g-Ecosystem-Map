// Exports the PUBLIC part of the Notion backend to data/ecosystem.json.
// Privacy rule: only rows with "Public on map" ticked are exported, and only the
// whitelisted columns below. Private columns (Relationship status, owner, notes,
// last contact, email, LinkedIn, phone) are never read into the output.
//
// Env: NOTION_TOKEN (required), ECOSYSTEM_DB, CONNECTIONS_DB (optional overrides)
import { readFile, writeFile } from "node:fs/promises";

const TOKEN = process.env.NOTION_TOKEN;
const ECOSYSTEM_DB = process.env.ECOSYSTEM_DB || "93b1c87ef8ea492b97fed1844204216b";
const CONNECTIONS_DB = process.env.CONNECTIONS_DB || "8d1dfe6058de43b7bdeaa22597fb2e43";
const OUT = new URL("../data/ecosystem.json", import.meta.url);
if (!TOKEN) { console.error("NOTION_TOKEN is not set"); process.exit(1); }

async function queryAll(dbId) {
  const rows = []; let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      body: JSON.stringify({ page_size: 100, start_cursor: cursor, filter: { property: "Public on map", checkbox: { equals: true } } }),
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
const slug = (s, id) => (s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item") + "-" + id.slice(0, 4);

const eco = await queryAll(ECOSYSTEM_DB);
const idOf = new Map(); // notion page id -> map id
for (const pg of eco) { const p = pg.properties; idOf.set(pg.id.replace(/-/g, ""), text(p["Map ID"]) || slug(text(p["Name"]), pg.id.replace(/-/g, ""))); }

const nodes = eco.map(pg => {
  const p = pg.properties; const id = idOf.get(pg.id.replace(/-/g, ""));
  const org = rel(p["Organisation"]).map(x => idOf.get(x)).find(Boolean) || null; // only public orgs resolve
  // WHITELIST: add a field here only if it is safe to publish
  return {
    id, name: text(p["Name"]), short: text(p["Short name"]), category: sel(p["Category"]) || "Person",
    region: sel(p["Region"]) || "Rest of US & global", description: text(p["Description"]), role: text(p["Role"]), org,
    address: text(p["Address"]), lat: num(p["Latitude"]), lng: num(p["Longitude"]), precision: sel(p["Location precision"]),
    sources: text(p["Sources"]).split(/\s+/).filter(s => /^https?:\/\//.test(s)),
  };
}).filter(n => n.name);
// People never carry their own coordinates: they are shown at their organisation
for (const n of nodes) if (n.category === "Person") { n.lat = null; n.lng = null; n.address = ""; }

const conns = await queryAll(CONNECTIONS_DB);
const edges = [];
for (const pg of conns) {
  const p = pg.properties;
  const from = idOf.get(rel(p["From"])[0]), to = idOf.get(rel(p["To"])[0]);
  if (!from || !to) continue; // one end is private or missing
  edges.push({ from, to, type: sel(p["Type"]) || "Partnership / project", label: text(p["Label"]), source: url(p["Source URL"]) });
}
// People added with an Organisation but no Role connection still get linked
for (const n of nodes) if (n.org && !edges.some(e => e.from === n.id && e.to === n.org)) edges.push({ from: n.id, to: n.org, type: "Role", label: n.role || "Works here", source: "" });

nodes.sort((a, b) => a.id.localeCompare(b.id));
edges.sort((a, b) => (a.from + a.to + a.type).localeCompare(b.from + b.to + b.type));
let prev = null; try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch {}
const same = prev && JSON.stringify({ n: prev.nodes, e: prev.edges }) === JSON.stringify({ n: nodes, e: edges });
if (same) { console.log("No public changes."); process.exit(0); }
await writeFile(OUT, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), nodes, edges }, null, 1) + "\n");
console.log(`Wrote ${nodes.length} entries and ${edges.length} connections.`);
