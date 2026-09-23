/** Public HTTPS deployments use their own authenticated Worker gateway. */
export function hostApiBase(location?: Pick<Location, 'protocol' | 'hostname' | 'origin'>): string {
  if (!location) return 'http://127.0.0.1:43129';
  if (location.protocol === 'https:') return `${location.origin}/host`;
  const hostname = location.hostname || '127.0.0.1';
  return `http://${hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname}:43129`;
}
