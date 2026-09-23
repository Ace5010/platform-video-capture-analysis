import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';
import hostingConfig from './.openai/hosting.json';
import remoteHost from './cloudflare-host.json';

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

const localBindingConfig = {
  account_id: remoteHost.accountId,
  main: './cloudflare-worker.ts',
  compatibility_flags: ['nodejs_compat'],
  // The anonymous page shell is generated at build time. API requests always
  // enter the authenticated gateway, even when opened as a browser navigation.
  assets: { binding: 'ASSETS', run_worker_first: ['/host/*'] },
  vars: { HOST_PUBLIC_ORIGIN: remoteHost.publicOrigin },
  vpc_services: remoteHost.vpcServiceId
    ? [{ binding: 'HOST_SERVICE', service_id: remoteHost.vpcServiceId }]
    : [],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: 'site-creator-d1',
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: 'site-creator-r2',
        },
      ]
    : [],
};

export default defineConfig(async ({ command }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    server: {
      watch: {
        // Runtime Chrome/SQLite files are locked on Windows and never affect HMR.
        ignored: ['**/data/**', '**/.venv/**'],
        ...(isCodexSeatbeltSandbox ? { useFsEvents: false, usePolling: true } : {}),
      },
    },
    plugins: [
      vinext({ prerender: true }),
      sites(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        // Local browsing uses the existing host directly and must still start
        // offline, without a Cloudflare login or a remote VPC dev session.
        config: command === 'serve' ? { ...localBindingConfig, vpc_services: [] } : localBindingConfig,
      }),
    ],
  };
});
