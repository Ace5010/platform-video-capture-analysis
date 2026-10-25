import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Preserve the approved artwork; only mask the desktop tile's outer corners.
const root = new URL('../', import.meta.url);
const source = await readFile(new URL('assets/branding/observe-coral-source.png', root));
const mask = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect x="24" y="24" width="976" height="976" rx="224" fill="white"/></svg>');
const tile = await sharp(source).resize(976, 976).extend({ top: 24, bottom: 24, left: 24, right: 24, background: '#ffffff' })
  .composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
const sizes = [16, 24, 32, 48, 64, 96, 128, 256];
const frames = await Promise.all(sizes.map(size => sharp(tile).resize(size, size).png().toBuffer()));
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
const output = new URL('public/desktop-icons/', root);
await mkdir(output, { recursive: true });
await writeFile(new URL('observe-coral-rounded.ico', output), Buffer.concat([header, ...frames]));
await sharp(tile).resize(256, 256).png().toFile(fileURLToPath(new URL('observe-coral-rounded.png', output)));

await mkdir(new URL('outputs/', root), { recursive: true });
const previewLayers = [];
for (const [index, size] of [128, 64, 48, 32].entries()) {
  for (const top of [16, 176]) {
    previewLayers.push({ input: await sharp(tile).resize(size, size).png().toBuffer(), left: 16 + index * 144 + Math.floor((128 - size) / 2), top: top + Math.floor((128 - size) / 2) });
  }
}
const previewBackground = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="592" height="320"><path fill="#e7eaf0" d="M0 0h592v160H0z"/><path fill="#273342" d="M0 160h592v160H0z"/></svg>');
await sharp(previewBackground).composite(previewLayers).png().toFile(fileURLToPath(new URL('outputs/observe-desktop-rounded-preview.png', root)));
console.log(JSON.stringify({ icon: 'public/desktop-icons/observe-coral-rounded.ico', sizes, transparentCorners: true }));
