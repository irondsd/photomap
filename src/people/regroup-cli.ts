import { requireCopiedIndex } from "./trial";

if (Bun.argv.length > 2) throw new Error("Usage: bun run people:regroup");
if (process.env.PHOTOMAP_PEOPLE_AUTO !== "1" && !process.env.PHOTOMAP_DATA) {
  // The live index belongs to the running app, so regroup inside its container.
  throw new Error(
    "Run this inside the app: docker compose exec app bun run people:regroup\n" +
      "To try it on a copy instead, set PHOTOMAP_DATA to a directory containing a copy of index.sqlite.",
  );
}
if (process.env.PHOTOMAP_PEOPLE_AUTO !== "1" || process.env.PHOTOMAP_PEOPLE_PREVIEW === "1") {
  requireCopiedIndex();
}

const { db } = await import("../db");
const { hasPeople, regroupPeople } = await import("./store");
if (!hasPeople()) throw new Error("No faces yet. Run bun run people:detect first.");
db.run("PRAGMA busy_timeout = 5000");

// Named and hidden people keep their faces. Every other face is matched again from scratch.
const result = regroupPeople.immediate(true);
console.log(
  `Regrouped ${result.faces} faces: ${result.groupsBefore} → ${result.groupsAfter} groups, ` +
    `${result.moved} faces moved, ${result.removed} empty groups removed.`,
);
