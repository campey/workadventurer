// Ports of WorkAdventure's libs/shared-utils helpers. Used to derive the space
// name of a map-area meeting the same way the front-end does, and kept here so
// per-version adapters can call them.

export function shortHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

export function slugify(...args) {
  return args
    .join(" ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_ ]/g, "")
    .replace(/\s+/g, "-");
}
