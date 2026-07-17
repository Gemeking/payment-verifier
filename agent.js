// telebirr relay agent — run this on any computer INSIDE Ethiopia:
//
//   node agent.js https://payment-verifier-21ab.onrender.com
//
// It polls the hosted verifier for lookup jobs, fetches the official
// telebirr receipt (which only works from Ethiopian internet), and sends
// the page back so the site can verify automatically. Only URLs on
// transactioninfo.ethiotelecom.et are ever fetched.
const https = require('https');
const http = require('http');

const HUB = (process.argv[2] || 'https://payment-verifier-21ab.onrender.com').replace(/\/$/, '');
const KEY = process.argv[3] || process.env.RELAY_KEY || 'gemeking-relay-2026';

function request(url, { method = 'GET', body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, {
      method,
      rejectUnauthorized: false,
      headers: body
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        : { 'User-Agent': 'Mozilla/5.0' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  console.log('relay agent started — connected to ' + HUB);
  console.log('leave this window open; telebirr verifications on the website now run through this computer');
  while (true) {
    try {
      const r = await request(HUB + '/relay/poll?key=' + encodeURIComponent(KEY), { timeoutMs: 35000 });
      if (r.status === 403) {
        console.log('wrong relay key — check RELAY_KEY on the server and here');
        await new Promise((s) => setTimeout(s, 10000));
        continue;
      }
      let job = null;
      try { job = JSON.parse(r.body).job; } catch {}
      if (job && /^https:\/\/transactioninfo\.ethiotelecom\.et\//.test(job.url)) {
        process.stdout.write(new Date().toLocaleTimeString() + '  looking up ' + job.url.split('/').pop() + ' ... ');
        let ok = false, body = '';
        try {
          const res = await request(job.url, { timeoutMs: 15000 });
          ok = true;
          body = res.body;
          console.log('done (' + body.length + ' bytes)');
        } catch (e) {
          body = String(e.message);
          console.log('failed: ' + body);
        }
        await request(HUB + '/relay/result', {
          method: 'POST',
          body: JSON.stringify({ key: KEY, jobId: job.jobId, ok, body }),
          timeoutMs: 30000,
        });
      }
    } catch (e) {
      await new Promise((s) => setTimeout(s, 3000));
    }
  }
})();
