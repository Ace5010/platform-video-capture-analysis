type WorkspaceReads = {
  prepare: () => Promise<unknown>;
  state: (signal: AbortSignal) => Promise<unknown>;
  jobs: (signal: AbortSignal) => Promise<unknown>;
  settings: (signal: AbortSignal) => Promise<unknown>;
  ready: () => void;
  failed: (error: unknown, initial: boolean) => void;
};

/** One read cycle at a time, including the initial load and focus events. */
export function createWorkspaceRefresh(reads: WorkspaceReads) {
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  let prepared = false;
  let initial = true;
  const refresh = (): Promise<void> => {
    if (controller.signal.aborted) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      try {
        if (!prepared) { await reads.prepare(); prepared = true; }
        if (controller.signal.aborted) return;
        // History makes the page usable. Slow task/settings reads must not
        // keep an otherwise complete workspace behind the startup screen.
        await Promise.allSettled([
          reads.state(controller.signal).then(() => {
            if (controller.signal.aborted) return;
            initial = false;
            reads.ready();
          }).catch(error => { if (!controller.signal.aborted) reads.failed(error, initial); }),
          reads.jobs(controller.signal),
          reads.settings(controller.signal),
        ]);
      } catch (error) {
        if (!controller.signal.aborted) reads.failed(error, initial);
      }
    })().finally(() => { running = undefined; });
    return running;
  };
  return { refresh, stop: () => controller.abort() };
}
