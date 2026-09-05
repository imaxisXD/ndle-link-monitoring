export const serviceState = {
  started: false,
  stopping: false,
  lastSchedulerSuccess: 0,
  workerReady: false,
};

export function componentsReady(runScheduler: boolean, runWorker: boolean, now = Date.now()): boolean {
  return serviceState.started && !serviceState.stopping &&
    (!runScheduler || now - serviceState.lastSchedulerSuccess < 60_000) &&
    (!runWorker || serviceState.workerReady);
}
