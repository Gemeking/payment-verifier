// Simulates what the browser does: QR decode locally, then POST { qr } to
// /api/verify — tests the QR-only flow end to end.
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const jsQR = require('jsqr');

async function decodeQr(buffer) {
  const original = await Jimp.read(buffer);
  const variants = [
    (img) => img,
    (img) => img.grayscale().contrast(0.4),
    (img) => img.grayscale().contrast(0.4).posterize(2),
  ];
  for (const t of variants) {
    const img = t(original.clone());
    const { data, width, height } = img.bitmap;
    const code = jsQR(new Uint8ClampedArray(data), width, height);
    if (code && code.data) return code.data.trim();
  }
  return null;
}

(async () => {
  const dir = path.join(__dirname, '..');
  const files = ['1772631050697.jpg', 'screenshot_1783919110752.png', 'cbetransaction114.jpg'];
  for (const f of files) {
    const qr = await decodeQr(fs.readFileSync(path.join(dir, f)));
    const res = await fetch('http://localhost:3311/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qr, account: '' }),
    });
    console.log('=== ' + f + ' ===');
    console.log(JSON.stringify(await res.json(), null, 1));
  }
})();
