// Stock LeadForge's shelves: write one lead list per conference into the
// seller's 1Claw vault at leads/<slug>. The inventory lives encrypted in the
// HSM-backed vault — not on disk — and the storefront reads it per request.
//
// All people and companies here are SYNTHETIC (example.com domains) — demo data.
//
//   node seller/stock.mjs              # stock every conference
//   node seller/stock.mjs kubecon-na   # restock one
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, agentClient, unwrap } from "../shared/oneclaw.mjs";

loadEnv(dirname(fileURLToPath(import.meta.url)));
const client = agentClient();
const VAULT = process.env.ONECLAW_VAULT_ID;

const CONFERENCES = [
  { slug: "kubecon-na-2026", name: "KubeCon + CloudNativeCon NA 2026", city: "Atlanta", date: "2026-11-10", size: 60, focus: "platform" },
  { slug: "reinvent-2026", name: "AWS re:Invent 2026", city: "Las Vegas", date: "2026-12-01", size: 80, focus: "cloud" },
  { slug: "money2020-2026", name: "Money20/20 USA 2026", city: "Las Vegas", date: "2026-10-25", size: 50, focus: "fintech" },
  { slug: "ai-engineer-summit-2026", name: "AI Engineer Summit 2026", city: "San Francisco", date: "2026-09-14", size: 70, focus: "ai" },
  { slug: "saastr-annual-2026", name: "SaaStr Annual 2026", city: "San Mateo", date: "2026-09-09", size: 55, focus: "gtm" },
];

const ROLES = {
  platform: ["VP Platform Engineering", "Head of SRE", "Staff Platform Engineer", "Director of Infrastructure", "CTO", "Engineering Manager, DevEx"],
  cloud: ["Cloud Architect", "VP Engineering", "Director of Cloud Ops", "CTO", "Head of FinOps", "Principal Engineer"],
  fintech: ["Head of Payments", "VP Risk", "CTO", "Director of Compliance Engineering", "Product Lead, Payments", "CFO"],
  ai: ["Head of ML Platform", "AI Engineer", "VP Engineering", "Director of Applied AI", "CTO", "Staff ML Engineer"],
  gtm: ["VP Sales", "CRO", "Head of RevOps", "Director of Demand Gen", "CMO", "VP Customer Success"],
};
const FIRST = ["Avery", "Jordan", "Priya", "Mateo", "Sana", "Theo", "Imani", "Kenji", "Lucia", "Omar", "Rowan", "Noor", "Elena", "Dev", "Hana", "Marcus", "Ines", "Kofi", "Talia", "Wren"];
const LAST = ["Okafor", "Lindqvist", "Ramirez", "Chen", "Haddad", "Novak", "Patel", "Brennan", "Sato", "Mbeki", "Oyelaran", "Varga", "Duarte", "Kowalski", "Nakamura", "Ferreira", "Abernathy", "Iyer", "Castellanos", "Moreau"];
const CO_A = ["Northwind", "Bluefin", "Cobalt", "Lumen", "Arcadia", "Granite", "Helix", "Juniper", "Meridian", "Quasar", "Sable", "Tessellate"];
const CO_B = ["Labs", "Systems", "Cloud", "Health", "Pay", "Analytics", "Robotics", "Logistics", "Bank", "AI"];
const SIZES = ["51-200", "201-500", "501-1000", "1001-5000", "5000+"];
const INTENT = ["evaluating vendors", "visited booth", "attended talk", "requested follow-up", "badge scan only"];

// Deterministic PRNG so restocks are reproducible.
function rng(seed) {
  let s = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function leadsFor(conf) {
  const r = rng(conf.slug);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  return Array.from({ length: conf.size }, (_, i) => {
    const first = pick(FIRST);
    const last = pick(LAST);
    const company = `${pick(CO_A)} ${pick(CO_B)}`;
    const domain = `${company.toLowerCase().replace(/\s+/g, "")}.example.com`;
    return {
      id: `${conf.slug}-${String(i + 1).padStart(3, "0")}`,
      name: `${first} ${last}`,
      title: pick(ROLES[conf.focus]),
      company,
      company_size: pick(SIZES),
      email: `${first}.${last}@${domain}`.toLowerCase(),
      linkedin: `https://www.linkedin.com/in/example-${first}-${last}-${i}`.toLowerCase(),
      intent: pick(INTENT),
      score: Math.round(40 + r() * 60),
      synthetic: true,
    };
  });
}

const only = process.argv[2];
for (const conf of CONFERENCES.filter((c) => !only || c.slug === only)) {
  const leads = leadsFor(conf);
  const { slug, ...meta } = conf;
  unwrap(
    await client.secrets.set(VAULT, `leads/${slug}`, JSON.stringify({ conference: { slug, ...meta }, leads }), {
      type: "note",
      metadata: { conference: conf.name, count: leads.length, focus: conf.focus },
    }),
    `stock ${slug}`,
  );
  console.log(`✓ leads/${slug}  ${leads.length} leads  (${conf.name})`);
}
