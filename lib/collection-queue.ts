type CollectionJob = {
  type: string;
  status: string;
  payload: Record<string, unknown>;
  progress?: Record<string, unknown>;
};

export function isActiveCollectionJob(job: CollectionJob): boolean {
  return ['archive_account', 'collect_latest'].includes(job.type)
    && ['pending', 'queued', 'waiting', 'claimed', 'running', 'processing'].includes(job.status);
}

export function accountCollectionState(accountId: string, jobs: CollectionJob[]): 'queued' | 'running' | null {
  const matching = jobs.filter(job => isActiveCollectionJob(job)
    && (job.payload.accountId === accountId
      || (Array.isArray(job.payload.accountIds) && job.payload.accountIds.includes(accountId))));
  for (const job of matching) {
    if (!['claimed', 'running', 'processing'].includes(job.status)) continue;
    if (!Array.isArray(job.payload.accountIds) || job.payload.accountIds.length <= 1 || job.progress?.accountId === accountId) return 'running';
  }
  return matching.length ? 'queued' : null;
}
