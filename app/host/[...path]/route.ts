import { env } from 'cloudflare:workers';
import { proxyHostRequest, type HostProxyEnvironment } from '../../../lib/host-proxy';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return proxyHostRequest(request, env as HostProxyEnvironment);
}

// Media elements probe the playback route with HEAD before requesting ranges.
export function HEAD(request: Request) {
  return proxyHostRequest(request, env as HostProxyEnvironment);
}

export function POST(request: Request) {
  return proxyHostRequest(request, env as HostProxyEnvironment);
}
