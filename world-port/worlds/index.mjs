// Named worlds the scenarios can be set in (prod only).
import { fileURLToPath } from "node:url";

const facts = (f) => fileURLToPath(new URL(`./${f}`, import.meta.url));

export const WORLDS = {
  "afrolabs open space": {
    roomUrl: "https://play.workadventu.re/@/afrolabs/afrolabs/open-space",
    factsFile: facts("afrolabs-open-space.json"),
  },
  "the academy": {
    roomUrl: "https://play.workadventu.re/@/levelup-npc/lean-iterator/campus",
    factsFile: facts("lean-iterator-campus.json"),
  },
};
