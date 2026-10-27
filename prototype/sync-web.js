// Copies the prototype (the Teezy Swoosh artifact) into web/index.html, so localhost and
// GitHub Pages show exactly what the artifact shows. prototype/index.html is the source:
// edit it, then run this. The artifact host adds the doctype and <html> wrapper itself,
// so the prototype leaves them out and this script adds them for a normal web page.
//   npm run sync:web
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const src = fs.readFileSync(path.join(here, 'index.html'), 'utf8');

const page = '<!doctype html>\n<html lang="en">\n<!-- Generated from prototype/index.html by `npm run sync:web`. Edit the prototype, not this file. -->\n' + src.trimEnd() + '\n</html>\n';
fs.writeFileSync(path.join(root, 'web', 'index.html'), page);

// The posters the prototype uses live in web/assets too.
for (const f of fs.readdirSync(path.join(here, 'assets'))) {
  fs.copyFileSync(path.join(here, 'assets', f), path.join(root, 'web', 'assets', f));
}
console.log(`web/index.html updated from prototype/index.html (${Math.round(page.length / 1024)} KB)`);
