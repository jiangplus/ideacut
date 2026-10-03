// Parallel model calls where a few stragglers shouldn't hold everything up: once enough have
// succeeded, the rest get a short grace period and are dropped if still running.

export interface GatherOptions<T> {
  /** Results that count towards the quorum (others still wait the full time). */
  ok: (value: T) => boolean;
  /** How many good results end the wait (after the grace period). */
  quorum: number;
  graceMs: number;
}

/**
 * Settles with every task's result in order; `undefined` for tasks still running when the grace
 * period ends. A rejection (e.g. a fatal API error) rejects the whole gather.
 */
export function gather<T>(tasks: Promise<T>[], opts: GatherOptions<T>): Promise<(T | undefined)[]> {
  return new Promise((resolve, reject) => {
    const results: (T | undefined)[] = tasks.map(() => undefined);
    let settled = 0;
    let good = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      resolve([...results]);
    };
    if (!tasks.length) return done();
    tasks.forEach((task, i) =>
      task.then(
        (value) => {
          results[i] = value;
          if (opts.ok(value) && ++good === opts.quorum && settled + 1 < tasks.length) timer = setTimeout(done, opts.graceMs);
          if (++settled === tasks.length) done();
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      ),
    );
  });
}
