// Tests the no-QR fallbacks: OCR-found transaction IDs and manually typed IDs
const fs = require('fs');
const path = require('path');

async function post(payload) {
  const res = await fetch('http://localhost:3311/api/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

(async () => {
  const dir = path.join(__dirname, '..');
  const { createWorker } = require('tesseract.js');
  const worker = await createWorker('eng');

  for (const f of ['1772631050697.jpg', 'cbetransaction114.jpg']) {
    const { data } = await worker.recognize(fs.readFileSync(path.join(dir, f)));
    const out = await post({ qr: null, ocrText: data.text, account: '' });
    console.log('=== no QR, OCR only: ' + f + ' ===');
    console.log(out.verdict + ' | ' + out.confidence);
    console.log('fields:', JSON.stringify(out.fields));
    console.log('steps:', JSON.stringify(out.steps));
  }
  await worker.terminate();

  console.log('=== manual ID: DC47F0BHXV ===');
  const m = await post({ txId: 'DC47F0BHXV' });
  console.log(m.verdict + ' | amount: ' + (m.fields && m.fields.amount) + ' | date: ' + (m.fields && m.fields.date));

  console.log('=== manual ID: fake AA11BB22CC ===');
  const fk = await post({ txId: 'AA11BB22CC' });
  console.log(fk.verdict + ' | ' + fk.confidence);
})();
