// Holds audio pushed to an SttStream before its pipeline (worker socket /
// ffmpeg) exists, so a cold worker start (~2-5 s of MLX import + model warm)
// doesn't eat the head of the first utterance (#58). Bounded: if startup takes
// longer than the budget, the oldest audio is dropped, never memory.

export class PreQueue {
  /** @param {number} maxSize budget in whatever unit `push` is given (bytes, samples…) */
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.items = [];
    this.size = 0;
    this.dropped = 0;
  }

  push(item, size) {
    this.items.push({ item, size });
    this.size += size;
    // Always keep the newest item, even if it alone exceeds the budget.
    while (this.size > this.maxSize && this.items.length > 1) {
      this.size -= this.items.shift().size;
      this.dropped++;
    }
  }

  /** Hand every queued item to `fn` in arrival order and empty the queue. */
  drain(fn) {
    const items = this.items;
    this.items = [];
    this.size = 0;
    for (const { item } of items) fn(item);
  }
}
