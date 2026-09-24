import { getStore } from "@netlify/blobs";

export const config = { path: "/api/*" };

const TZ = "Pacific/Auckland";
const DEF = { name: "Medication box checks", count: 20, warnDays: 30, checkDays: 30, labels: {}, items: [] };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const isCid = (c) => typeof c === "string" && /^c\d{2}$/.test(c);
const isDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));
const clean = (v, n) => String(v ?? "").trim().slice(0, n);
const int = (v, lo, hi, d) => { const n = parseInt(v, 10); return isNaN(n) ? d : Math.max(lo, Math.min(hi, n)); };
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const fmtDate = (d) => { const [y, m, day] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); };
const userErr = (msg) => Object.assign(new Error(msg), { user: true });
const pinOk = (body) => !process.env.ADMIN_PIN || String(body.pin || "") === process.env.ADMIN_PIN;

// Starting contents, added once. Removing an item later keeps it removed.
const SEED = [
  ["Amlodipine tabs",1,""],["Amoxicillin tabs 500mg",2,"box"],["Amoxiclav tabs 500/125mg",2,"box"],
  ["Bisacodyl supps",1,"box"],["Cefalexin tabs 500mg",2,"box"],["Doxycycline tabs 100mg",1,"box"],
  ["Electral sachets",1,"box"],["ENTOP spray",1,""],["Fleet enema",1,""],
  ["Flucloxacillin tabs 500mg",2,"box"],["Hyoscine inj",1,""],["Laxsol tabs",1,""],
  ["Levomepromazine inj",1,""],["Loperamide tabs",1,""],["Macrogol sachets",1,"box"],
  ["Metoclopramide inj",1,""],["Metoclopramide tabs",1,""],["Metoprolol tabs",1,""],
  ["Metronidazole tabs 200mg",2,"box"],["Microlax enema",2,""],["Nitrofurantoin tabs 100mg",1,"box"],
  ["Ondansetron tabs 4mg",1,"box"],["Ondansetron tabs 8mg",1,"box"],["Paracetamol IV",1,""],
  ["Parecoxib inj",1,""],["Pregabalin tabs",1,""],["Prochlorperazine inj",1,""],
  ["Prochlorperazine tabs",1,""],["Roxithromycin tabs 300mg",2,"box"],["Trisul tabs 80/400mg",2,"box"],
];
async function ensureSeed(store) {
  let added = 0;
  const r = await mutate(store, "config", () => ({ ...DEF }), (cfg) => {
    if (cfg.seededV1) return false;
    cfg.items = cfg.items || [];
    const have = new Set(cfg.items.map((i) => i.name.toLowerCase()));
    added = 0;
    for (const [name, min, unit] of SEED) if (!have.has(name.toLowerCase())) { cfg.items.push({ id: rid(), name, min, unit }); added++; }
    cfg.items.sort((a, b) => a.name.localeCompare(b.name));
    cfg.seededV1 = true;
  });
  if (r.changed && added) await masterLog(store, "Setup", `loaded ${added} medications from the starting list`);
}

async function getConfig(store) { return { ...DEF, ...((await store.get("config", { type: "json" })) || {}) }; }

// Read, change and write one blob, retrying if someone else saved in between.
async function mutate(store, key, fallback, fn) {
  for (let i = 0; i < 6; i++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const val = cur ? cur.data : fallback();
    if (fn(val) === false) return { value: val, changed: false };
    const res = cur ? await store.setJSON(key, val, { onlyIfMatch: cur.etag }) : await store.setJSON(key, val, { onlyIfNew: true });
    if (res && res.modified === false) continue;
    return { value: val, changed: true };
  }
  throw userErr("Busy. Try again.");
}
const blankBox = () => ({ items: {}, log: [] });
function addLog(c, by, t) { c.log = Array.isArray(c.log) ? c.log : []; c.log.unshift({ at: Date.now(), by, t }); c.log = c.log.slice(0, 100); }
async function masterLog(store, by, t) {
  await mutate(store, "masterlog", () => ({ entries: [] }), (m) => { m.entries = [{ at: Date.now(), by, t }, ...(m.entries || [])].slice(0, 100); });
}
const batchesOf = (c, id) => ((c.items || {})[id]?.batches || []).filter((b) => b.qty > 0).map((b) => ({ ...b }));
const goodQty = (bs) => bs.filter((b) => b.exp >= today()).reduce((s, b) => s + b.qty, 0);
function addBatch(c, id, qty, exp, by) {
  c.items = c.items || {};
  const bs = batchesOf(c, id);
  const same = bs.find((b) => b.exp === exp);
  if (same) { same.qty += qty; same.by = by; same.at = Date.now(); } else bs.push({ id: rid(), qty, exp, by, at: Date.now() });
  c.items[id] = { batches: bs };
}

function singleOp(c, body, cfg, by) {
  c.items = c.items || {};
  const item = cfg.items.find((i) => i.id === body.itemId);
  if (body.op === "add") {
    const qty = int(body.qty, 0, 999, 0);
    if (!item || !qty || !isDate(body.exp)) throw userErr("Check the amount and expiry date.");
    addBatch(c, item.id, qty, body.exp, by);
    addLog(c, by, `signed in ${qty} ${item.name}, exp ${fmtDate(body.exp)}`);
  } else if (body.op === "use" || body.op === "remove") {
    if (!item) throw userErr("That medication is no longer on the list.");
    const bs = batchesOf(c, item.id);
    const b = bs.find((x) => x.id === body.bid);
    if (!b) throw userErr("That stock was already changed by someone else.");
    if (body.op === "use") { b.qty -= 1; addLog(c, by, `used 1 ${item.name} (exp ${fmtDate(b.exp)})`); }
    else { addLog(c, by, `removed ${b.qty} ${b.exp < today() ? "expired " : ""}${item.name} (exp ${fmtDate(b.exp)})`); b.qty = 0; }
    c.items[item.id] = { batches: bs.filter((x) => x.qty > 0) };
  } else if (body.op === "check") {
    c.checked = { by, at: Date.now() };
    addLog(c, by, "checked box" + (clean(body.note, 60) ? ", " + clean(body.note, 60) : ""));
  } else throw userErr("Unknown action.");
}

export default async (req) => {
  const store = getStore({ name: "medcheck", consistency: "strong" });
  const path = new URL(req.url).pathname.replace(/^\/api\/?/, "");
  try {
    if (req.method === "GET" && path === "state") {
      await ensureSeed(store);
      const [cfg, ml, { blobs }] = await Promise.all([getConfig(store), store.get("masterlog", { type: "json" }), store.list({ prefix: "c/" })]);
      const containers = {};
      await Promise.all(blobs.map(async (b) => { containers[b.key.slice(2)] = await store.get(b.key, { type: "json" }); }));
      return json({ config: cfg, containers, masterlog: ((ml && ml.entries) || []).slice(0, 30), pinRequired: !!process.env.ADMIN_PIN, today: today() });
    }
    if (req.method !== "POST") return json({ error: "Not found" }, 404);
    let body;
    try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
    const by = clean(body.by, 20) || "?";

    if (path === "pin") return pinOk(body) ? json({ ok: true }) : json({ error: "That PIN is not right." }, 403);

    if (path === "op") {
      if (!isCid(body.cid)) throw userErr("Unknown box.");
      const cfg = await getConfig(store);
      const r = await mutate(store, "c/" + body.cid, blankBox, (c) => singleOp(c, body, cfg, by));
      return json({ container: r.value });
    }

    if (!pinOk(body)) return json({ error: "That PIN is not right." }, 403);

    if (path === "items") {
      let removed = null, msg = "";
      const r = await mutate(store, "config", () => ({ ...DEF }), (cfg) => {
        cfg.items = cfg.items || [];
        if (body.action === "add") {
          const name = clean(body.name, 80);
          if (!name) throw userErr("Enter a medication name.");
          if (cfg.items.some((i) => i.name.toLowerCase() === name.toLowerCase())) throw userErr("That medication is already on the list.");
          if (cfg.items.length >= 100) throw userErr("The list is full.");
          cfg.items.push({ id: rid(), name, min: int(body.min, 0, 999, 1), unit: body.unit === "box" ? "box" : "" });
          cfg.items.sort((a, b) => a.name.localeCompare(b.name));
          msg = `added ${name} to every box, minimum ${int(body.min, 0, 999, 1)}`;
        } else if (body.action === "update") {
          const it = cfg.items.find((i) => i.id === body.id);
          if (!it) throw userErr("That medication is no longer on the list.");
          const name = clean(body.name, 80) || it.name, min = int(body.min, 0, 999, it.min);
          const unit = body.unit === "box" ? "box" : "";
          const parts = [];
          if (unit !== (it.unit || "")) parts.push(`${name} now counted in ${unit ? "boxes" : "single items"}`);
          if (name !== it.name) parts.push(`renamed ${it.name} to ${name}`);
          if (min !== it.min) parts.push(`changed ${name} minimum from ${it.min} to ${min}`);
          if (!parts.length) return false;
          it.name = name; it.min = min; it.unit = unit; msg = parts.join(", ");
        } else if (body.action === "remove") {
          const it = cfg.items.find((i) => i.id === body.id);
          if (!it) return false;
          removed = it; cfg.items = cfg.items.filter((i) => i.id !== body.id);
          msg = `removed ${it.name} from every box`;
        } else throw userErr("Unknown action.");
      });
      if (r.changed) {
        await masterLog(store, by, msg);
        if (removed) {
          const { blobs } = await store.list({ prefix: "c/" });
          await Promise.all(blobs.map((b) => mutate(store, b.key, blankBox, (c) => {
            const n = batchesOf(c, removed.id).reduce((s, x) => s + x.qty, 0);
            addLog(c, by, `${removed.name} taken off the contents list` + (n ? `, ${n} still recorded in this box` : ""));
          })));
        }
      }
      return json({ config: r.value });
    }

    if (path === "settings") {
      const r = await mutate(store, "config", () => ({ ...DEF }), (cfg) => {
        cfg.name = clean(body.name, 60) || DEF.name;
        cfg.count = int(body.count, 1, 40, 20);
        cfg.warnDays = int(body.warnDays, 1, 365, 30);
        cfg.checkDays = int(body.checkDays, 1, 365, 30);
        cfg.labels = {};
        for (const [k, v] of Object.entries(body.labels || {})) if (isCid(k) && parseInt(k.slice(1), 10) <= cfg.count && clean(v, 40)) cfg.labels[k] = clean(v, 40);
      });
      return json({ config: r.value });
    }

    if (path === "bulk") {
      const cfg = await getConfig(store);
      const allCids = Array.from({ length: cfg.count }, (_, i) => "c" + String(i + 1).padStart(2, "0"));
      const targets = (Array.isArray(body.cids) ? body.cids : allCids).filter((c) => allCids.includes(c));
      if (!targets.length) throw userErr("No boxes selected.");
      let units = 0, boxes = 0, summary;
      const updated = {};

      if (body.kind === "add") {
        const item = cfg.items.find((i) => i.id === body.itemId);
        const topup = body.mode === "topup";
        const qty = int(body.qty, 0, 999, 0);
        if (!item || !isDate(body.exp) || body.exp < today() || (!topup && !qty)) throw userErr("Check the medication, amount and expiry date.");
        for (const cid of targets) {
          const r = await mutate(store, "c/" + cid, blankBox, (c) => {
            const n = topup ? Math.max(0, item.min - goodQty(batchesOf(c, item.id))) : qty;
            if (!n) return false;
            addBatch(c, item.id, n, body.exp, by);
            addLog(c, by, `${topup ? "topped up" : "bulk signed in"} ${n} ${item.name}, exp ${fmtDate(body.exp)}`);
            units += n; boxes++;
          });
          if (r.changed) updated[cid] = r.value;
        }
        summary = `${topup ? "topped up" : "signed in"} ${units} ${item.name} across ${boxes} box${boxes === 1 ? "" : "es"}, exp ${fmtDate(body.exp)}`;
      } else if (body.kind === "remove") {
        const expired = body.mode === "expired";
        if (!expired && !isDate(body.exp)) throw userErr("Choose the expiry date to remove.");
        const items = body.itemId === "all" ? cfg.items : cfg.items.filter((i) => i.id === body.itemId);
        if (!items.length) throw userErr("Choose a medication.");
        const t = today();
        for (const cid of targets) {
          const r = await mutate(store, "c/" + cid, blankBox, (c) => {
            let hit = 0; const parts = [];
            for (const it of items) {
              const bs = batchesOf(c, it.id);
              const gone = bs.filter((b) => (expired ? b.exp < t : b.exp === body.exp));
              if (!gone.length) continue;
              const n = gone.reduce((s, b) => s + b.qty, 0);
              hit += n; parts.push(`${n} ${it.name}`);
              c.items[it.id] = { batches: bs.filter((b) => !gone.includes(b)) };
            }
            if (!hit) return false;
            addLog(c, by, `bulk removed ${expired ? "expired " : ""}${parts.join(", ")}${expired ? "" : ", exp " + fmtDate(body.exp)}`);
            units += hit; boxes++;
          });
          if (r.changed) updated[cid] = r.value;
        }
        summary = `removed ${units} ${expired ? "expired units" : "units exp " + fmtDate(body.exp)} across ${boxes} box${boxes === 1 ? "" : "es"}`;
      } else throw userErr("Unknown action.");

      if (units) await masterLog(store, by, summary);
      return json({ updated, units, boxes, summary });
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    if (e.user) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: "Something went wrong on the server. Try again." }, 500);
  }
};
