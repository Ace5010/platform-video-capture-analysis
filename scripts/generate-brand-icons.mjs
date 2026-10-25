import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Resize the exact approved coral/amber image; never regenerate the artwork.
const root = new URL('../', import.meta.url);
const source = await readFile(new URL('assets/branding/observe-coral-source.png', root));
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const resize = size => sharp(source).resize(size, size, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
const save = async (relative, data) => {
  const target = new URL(relative, root);
  await mkdir(new URL('./', target), { recursive: true });
  await writeFile(target, data);
};
const webFiles = [];
for (const size of [32, 96, 180, 192, 512]) {
  const name = `app-icons/observe-coral-${size}.png`;
  await save(`public/${name}`, await resize(size));
  webFiles.push('/' + name);
}
const maskable = await sharp(source).resize(336, 336).extend({ top: 88, bottom: 88, left: 88, right: 88, background: '#ffffff' }).png().toBuffer();
await save('public/app-icons/observe-coral-maskable-512.png', maskable);
webFiles.push('/app-icons/observe-coral-maskable-512.png');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const frames = await Promise.all(sizes.map(resize));
const header = Buffer.alloc(6 + frames.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
for (const [i, frame] of frames.entries()) {
  const entry = 6 + i * 16;
  header[entry] = sizes[i] === 256 ? 0 : sizes[i];
  header[entry + 1] = header[entry];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(frame.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += frame.length;
}
const ico = Buffer.concat([header, ...frames]);
await save('public/app-icons/observe-coral.ico', ico);
await save('public/favicon.ico', ico);
webFiles.push('/app-icons/observe-coral.ico', '/favicon.ico');
await save('public/apple-touch-icon.png', await resize(180));
webFiles.push('/apple-touch-icon.png');
await save('public/favicon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><image width="96" height="96" href="data:image/png;base64,${(await resize(96)).toString('base64')}"/></svg>`);
webFiles.push('/favicon.svg');
await save('public/manifest.webmanifest', JSON.stringify({ name: 'Observe', short_name: 'Observe', start_url: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#ffffff', icons: [
  { src: '/app-icons/observe-coral-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/app-icons/observe-coral-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/app-icons/observe-coral-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
] }, null, 2) + '\n');
webFiles.push('/manifest.webmanifest');
await save('public/app-icons/observe-coral-brand.css', '.observeBrand{display:inline-flex;align-items:center;gap:8px}.observeBrand::before{content:"";display:inline-block;flex:none;width:28px;height:28px;background:url("/app-icons/observe-coral-192.png") center/contain no-repeat}.accessMark{display:grid;place-items:center;background:transparent;box-shadow:none}.accessMark>.platformIcon{display:none}.accessMark::before{content:"";display:block;width:56px;height:56px;background:url("/app-icons/observe-coral-192.png") center/contain no-repeat}\n');
webFiles.push('/app-icons/observe-coral-brand.css');
const legacyMask = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect x="12" y="12" width="488" height="488" rx="112" fill="white"/></svg>');
const legacy = await sharp(source).resize(488, 488).extend({ top: 12, bottom: 12, left: 12, right: 12, background: '#ffffff' })
  .composite([{ input: legacyMask, blend: 'dest-in' }]).png().toBuffer();
for (const [density, size] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 })) {
  await save(`android/app/src/main/res/mipmap-${density}/ic_launcher.png`, await sharp(legacy).resize(size, size).png().toBuffer());
}
await save('android/app/src/main/res/drawable-nodpi/observe_launcher_legacy.png', legacy);
// Android applies the launcher's circular or rounded-square mask to these layers.
const adaptive = await sharp(source).resize(288, 288).extend({ top: 72, bottom: 72, left: 72, right: 72, background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer();
await save('android/app/src/main/res/drawable-nodpi/observe_launcher_foreground.png', adaptive);
const files = {};
for (const file of webFiles) {
  const bytes = await readFile(new URL('public' + file, root));
  files[file] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
await save('public/app-icons/brand.json', JSON.stringify({ design: 'coral-amber-no-ring', sourceSha256, files }, null, 2) + '\n');
const layers = await Promise.all([128, 64, 48, 32].map(async (size, i) => ({ input: await resize(size), left: 30 + i * 150 + Math.floor((128 - size) / 2), top: 24 + Math.floor((128 - size) / 2) })));
await mkdir(new URL('outputs/', root), { recursive: true });
await sharp({ create: { width: 660, height: 180, channels: 4, background: '#edf1f5' } }).composite(layers).png().toFile(fileURLToPath(new URL('outputs/observe-approved-icon-sizes.png', root)));
console.log(JSON.stringify({ design: 'coral-amber-no-ring', sourceSha256, webFiles: webFiles.length, androidDensities: 5 }));
