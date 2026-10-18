import { proxyHostRequest, type HostProxyEnvironment } from './lib/host-proxy';
import app from 'vinext/server/app-router-entry';

type WorkerEnvironment = HostProxyEnvironment & {
  ASSETS?: { fetch(request: Request): Promise<Response> };
};

const worker = {
  async fetch(request: Request, env: WorkerEnvironment, ctx: ExecutionContext): Promise<Response> {
    // The restricted host gateway streams JSON and registered media without React rendering.
    // Keep the existing origin, cookie, CSRF, and path checks in one shared handler.
    if (new URL(request.url).pathname.startsWith('/host/')) {
      return proxyHostRequest(request, env);
    }
    return app.fetch(request, env, ctx);
  },
};

export default worker;
