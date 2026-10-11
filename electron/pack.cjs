// Packages the app into dist/EchoScoreboard-win32-x64/EchoScoreboard.exe
const path = require('node:path');
const fs = require('node:fs');
(async () => {
  const { packager } = require('@electron/packager');
  const root = path.join(__dirname, '..');
  const icon = path.join(__dirname, 'icon.ico');
  const out = await packager({
    dir: root,
    name: 'EchoScoreboard',
    platform: 'win32',
    arch: 'x64',
    out: path.join(root, 'dist'),
    overwrite: true,
    asar: false,
    prune: true,
    ...(fs.existsSync(icon) ? { icon } : {}),
    ignore: [/^\/dist($|\/)/, /^\/\.claude($|\/)/, /^\/\.git($|\/)/, /^\/\.gitattributes$/, /^\/autoclip\.json$/, /^\/README\.md$/, /^\/mvp-awards\.json\.bak$/],
  });
  console.log('Packaged:', out.join(', '));
})().catch(e => { console.error(e); process.exit(1); });
