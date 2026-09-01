export const MINIMUM_ANALYSIS_EXTENSION_VERSION = '0.8.0';
export const REQUIRED_ANALYSIS_EXTENSION_CAPABILITY = 'analyze_video';

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
};

function parseSemver(value: unknown): ParsedSemver | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
  };
}

export function semverAtLeast(version: unknown, minimum: string): boolean {
  const candidate = parseSemver(version);
  const floor = parseSemver(minimum);
  if (!candidate || !floor) return false;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (candidate[key] !== floor[key]) return candidate[key] > floor[key];
  }
  if (candidate.prerelease === floor.prerelease) return true;
  if (candidate.prerelease === null) return true;
  if (floor.prerelease === null) return false;
  return candidate.prerelease.localeCompare(floor.prerelease, 'en', { numeric: true }) >= 0;
}

export function isAnalysisExtensionCompatible(
  version: unknown,
  capabilities: readonly unknown[],
): boolean {
  return semverAtLeast(version, MINIMUM_ANALYSIS_EXTENSION_VERSION)
    && capabilities.includes(REQUIRED_ANALYSIS_EXTENSION_CAPABILITY);
}
