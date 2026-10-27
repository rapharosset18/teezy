// Builds the shareable artifact version of the app into artifact/dist/:
// web/classic.html (the server-wired UI) with the in-browser API stand-in (demo-api.js) and engine.js inlined,
// plus the images. Run it after changing web/, then republish artifact/dist/index.html.
//   node artifact/build.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const web = path.join(root, 'web');
const dist = path.join(here, 'dist');

let html = fs.readFileSync(path.join(web, 'classic.html'), 'utf8');
const engine = fs.readFileSync(path.join(web, 'engine.js'), 'utf8');
const demoApi = fs.readFileSync(path.join(here, 'demo-api.js'), 'utf8');

function replaceOnce(from, to) {
  if (!html.includes(from)) throw new Error(`build: couldn't find ${JSON.stringify(from)} in web/classic.html`);
  html = html.replace(from, () => to);
}

// The artifact host wraps the page in its own document with a viewport meta, so drop ours.
html = html
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<html[^>]*>\s*/i, '')
  .replace(/<\/html>\s*$/i, '')
  .replace(/<\/?head>\s*/gi, '')
  .replace(/<body[^>]*>\s*/i, '')
  .replace(/<\/body>\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '');

// The stand-in must load before the app's own script makes its first request.
replaceOnce('<script src="engine.js"></script>', `<script>\n${demoApi}\n</script>\n<script>\n${engine}\n</script>`);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
fs.writeFileSync(path.join(dist, 'index.html'), html);
for (const f of fs.readdirSync(path.join(web, 'assets'))) {
  fs.copyFileSync(path.join(web, 'assets', f), path.join(dist, 'assets', f));
}
console.log(`built ${path.relative(root, dist)}/index.html (${Math.round(html.length / 1024)} KB) and ${fs.readdirSync(path.join(dist, 'assets')).length} images`);
