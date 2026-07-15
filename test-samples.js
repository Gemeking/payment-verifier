// Quick offline test of QR decode + OCR extraction on the sample receipts
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
    (img) => img.resize(img.bitmap.width * 2, Jimp.AUTO).grayscale().contrast(0.5),
  ];
  for (let i = 0; i < variants.length; i++) {
    const img = variants[i](original.clone());
    const { data, width, height } = img.bitmap;
    const code = jsQR(new Uint8ClampedArray(data), width, height);
    if (code && code.data) return { data: code.data.trim(), variant: i };
  }
  return null;
}

(async () => {
  const dir = path.join(__dirname, '..');
  const files = fs.readdirSync(dir).filter((f) => /\.(jpg|jpeg|png)$/i.test(f));
  const { createWorker } = require('tesseract.js');
  const worker = await createWorker('eng');

  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    console.log('=== ' + f + ' ===');
    try {
      const qr = await decodeQr(buf);
      console.log('QR:', qr ? qr.data + ' (variant ' + qr.variant + ')' : 'NOT READABLE');
    } catch (e) {
      console.log('QR error:', e.message);
    }
    try {
      const { data } = await worker.recognize(buf);
      const t = data.text.replace(/\s+/g, ' ');
      const amount = t.match(/ETB\s*([\d,]+\.\d{2})\s*(?:has been\s*)?debited/i) || t.match(/-\s*([\d,]+\.\d{2})\s*\(?\s*ETB\s*\)?/i);
      const ft = t.match(/\b(FT[A-Z0-9]{8,14})\b/);
      const tx = t.match(/Transaction (?:Number|No\.?|ID)\s*:?\s*([A-Z0-9]{8,14})\b/i);
      const date = t.match(/(\d{4}\/\d{2}\/\d{2}[ T]\d{2}:\d{2}:\d{2})/) || t.match(/([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)/) || t.match(/(\d{1,2}-[A-Z][a-z]{2}-\d{4})/);
      console.log('OCR amount:', amount ? amount[1] : 'none', '| txId:', ft ? ft[1] : (tx ? tx[1] : 'none'), '| date:', date ? date[1] : 'none');
    } catch (e) {
      console.log('OCR error:', e.message);
    }
  }
  await worker.terminate();
})();
