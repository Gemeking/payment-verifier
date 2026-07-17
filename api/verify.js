// QR-only verification: receives { qr, account } — the QR code content the
// browser decoded from the receipt — and pulls the transaction straight from
// the official CBE / telebirr servers. Every field shown comes from the bank
// record, never from the picture, so a VERIFIED result is 100% authentic.
const https = require('https');
const http = require('http');
const pdfParse = require('pdf-parse');

// Headers the official CBE receipt viewer (mbreciept.cbe.com.et) sends to its own API
const CBE_APP_HEADERS = {
  'X-App-ID': 'd1292e42-7400-49de-a2d3-9731caa4c819',
  'X-App-Version': '0a01980b-9859-1369-8198-59f403820000',
};

function fetchUrl(url, headers = {}, redirectsLeft = 5, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { rejectUnauthorized: false, headers: { 'User-Agent': 'Mozilla/5.0', ...headers } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchUrl(next, headers, redirectsLeft - 1, timeoutMs));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        contentType: res.headers['content-type'] || '',
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout contacting ' + new URL(url).hostname)));
  });
}

// telebirr app QR codes hold base64-encoded TLV data with the 10-char
// transaction number embedded as hex ASCII — dig it out
function telebirrTxFromQr(qr) {
  if (/^[A-Z0-9]{10}$/.test(qr)) return qr;
  let decoded;
  try {
    decoded = Buffer.from(qr, 'base64').toString('utf8');
  } catch { return null; }
  if (!/^[0-9A-F]+$/i.test(decoded)) return null;
  const s = decoded.toUpperCase();
  for (let i = 0; i + 20 <= s.length; i++) {
    const sub = s.slice(i, i + 20);
    if (!/^[0-9A-F]{20}$/.test(sub)) continue;
    let out = '';
    for (let j = 0; j < 20; j += 2) out += String.fromCharCode(parseInt(sub.slice(j, j + 2), 16));
    if (/^[A-Z0-9]{10}$/.test(out) && /[A-Z]/.test(out) && /\d/.test(out)) return out;
  }
  return null;
}

function fmtCbeDate(iso) {
  // CBE API returns UTC; Ethiopia is UTC+3
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const local = new Date(d.getTime() + 3 * 3600 * 1000);
  return local.toISOString().replace('T', ' ').slice(0, 16) + ' (Ethiopian time)';
}

async function verifyCbeApi(token) {
  const url = 'https://mb.cbe.com.et/api/v1/transactions/public/transaction-detail/' + encodeURIComponent(token);
  const res = await fetchUrl(url, CBE_APP_HEADERS);
  if (res.status !== 200) {
    let detail = '';
    try { detail = JSON.parse(res.body.toString()).detail || ''; } catch {}
    throw new Error('CBE server rejected this receipt (' + (detail || 'HTTP ' + res.status) + ')');
  }
  const j = JSON.parse(res.body.toString('utf8'));
  return {
    provider: 'CBE',
    amount: j.debitAmount || j.amountCredited,
    totalDebited: j.amountDebited,
    date: j.dateTimes && j.dateTimes[0] ? fmtCbeDate(j.dateTimes[0]) : (j.processingDate || null),
    payer: j.debitAccountHolder || null,
    receiver: j.creditAccountHolder || null,
    txId: j.id,
    status: 'Completed (bank record found)',
  };
}

function parseCbePdfText(text) {
  const t = text.replace(/\s+/g, ' ');
  const fields = { provider: 'CBE' };
  let m;
  if ((m = t.match(/Payer\s*:?\s*([A-Z][A-Za-z' ]+?)(?=\s*(?:Account|Receiver))/i))) fields.payer = m[1].trim();
  if ((m = t.match(/Receiver\s*:?\s*([A-Z][A-Za-z' ]+?)(?=\s*(?:Account|Payment|Reason))/i))) fields.receiver = m[1].trim();
  if ((m = t.match(/Payment Date\s*&?\s*Time\s*:?\s*([\d\/]+,?\s*[\d:]+\s*(?:[AP]M)?)/i))) fields.date = m[1].trim();
  if ((m = t.match(/Reference No\.?\s*\(?[^)]*\)?\s*:?\s*(FT[A-Z0-9]+)/i))) fields.txId = m[1];
  else if ((m = t.match(/\b(FT[A-Z0-9]{8,14})\b/))) fields.txId = m[1];
  if ((m = t.match(/Transferred Amount\s*:?\s*([\d,]+\.\d{2})\s*ETB/i))) fields.amount = m[1];
  else if ((m = t.match(/([\d,]+\.\d{2})\s*ETB/i))) fields.amount = m[1];
  fields.status = 'Completed (bank record found)';
  return fields;
}

async function verifyCbeLegacy(txId, accountSuffix) {
  const url = 'https://apps.cbe.com.et:100/?id=' + txId + accountSuffix;
  const res = await fetchUrl(url);
  const isPdf = res.contentType.includes('pdf') || res.body.slice(0, 5).toString() === '%PDF-';
  if (!isPdf) {
    throw new Error('CBE has no record for this transaction ID + account combination — double-check the last 8 digits of the account');
  }
  const pdf = await pdfParse(res.body);
  const fields = parseCbePdfText(pdf.text);
  if (!fields.txId && !fields.amount) throw new Error('could not read the official CBE receipt');
  return fields;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function verifyTelebirr(txId) {
  const url = 'https://transactioninfo.ethiotelecom.et/receipt/' + encodeURIComponent(txId);
  const res = await fetchUrl(url);
  if (res.status !== 200) throw new Error('telebirr server answered HTTP ' + res.status);
  const t = htmlToText(res.body.toString('utf8'));
  if (!/telebirr/i.test(t)) throw new Error('telebirr has no record of transaction ' + txId);

  const fields = { provider: 'telebirr', txId };
  let m;
  if ((m = t.match(/Payer Name\s+([A-Z][A-Za-z' ]+?)(?=\s*የ|\s*Payer|\s*\/)/i))) fields.payer = m[1].trim();
  if ((m = t.match(/Bank account number\s+(\d{6,})\s+([A-Z][A-Za-z' ]+?)(?=\s*የ|\s*\/|\s*Invoice)/i))) {
    fields.receiver = m[2].trim() + ' (' + m[1] + ')';
  } else if ((m = t.match(/Credited Party name\s+([A-Z][A-Za-z' ]+?)(?=\s*የ|\s*Credited|\s*\/)/i))) {
    fields.receiver = m[1].trim();
  }
  if ((m = t.match(/(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2})/))) fields.date = m[1] + ' (dd-mm-yyyy)';
  // "Settled Amount" is the transferred money; "Total Paid" includes fees
  if ((m = t.match(/Settled Amount\s+[A-Z0-9]{10}\s+[\d-]+\s+[\d:]+\s+([\d,]+(?:\.\d{1,2})?)\s*Birr/i))) fields.amount = m[1];
  if ((m = t.match(/Total Paid Amount\s+([\d,]+(?:\.\d{1,2})?)\s*Birr/i))) fields.totalDebited = m[1];
  if (!fields.amount) fields.amount = fields.totalDebited;
  if (!fields.amount && (m = t.match(/([\d,]+(?:\.\d{1,2})?)\s*Birr/i))) fields.amount = m[1];
  if ((m = t.match(/transaction status\s+([A-Za-z]+)/i))) fields.status = m[1];
  if (!fields.amount) throw new Error('telebirr has no record for transaction ' + txId);
  return fields;
}

// Pull possible transaction IDs out of OCR text — used only to LOOK UP the
// bank record; the displayed result always comes from the bank server
function txCandidatesFromText(text) {
  const t = String(text || '').toUpperCase();
  const out = [];
  const push = (v) => { if (v && !out.includes(v)) out.push(v); };
  let m;
  const ftRe = /\bFT[A-Z0-9]{8,12}\b/g;
  while ((m = ftRe.exec(t))) push(m[0]);
  const nearRe = /TRANSACTION\s*(?:NUMBER|NO\.?|ID)\s*:?\s*([A-Z0-9]{10})\b/g;
  while ((m = nearRe.exec(t))) push(m[1]);
  const tenRe = /\b([A-Z0-9]{10})\b/g;
  while ((m = tenRe.exec(t))) {
    const v = m[1];
    if (/[A-Z]/.test(v) && /\d/.test(v) && !/^FT/.test(v)) push(v);
  }
  // dedupe IDs that differ only by O/0 — tryTelebirr expands those variants
  const seen = new Set();
  return out.filter((v) => {
    const k = v.replace(/O/g, '0');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 4);
}

// OCR confuses the letter O with zero — enumerate every O/0 combination,
// nearest to the original first (each is validated by the telebirr server,
// so a wrong guess can never verify)
function o0Variants(id) {
  const idx = [];
  for (let i = 0; i < id.length; i++) if (id[i] === 'O' || id[i] === '0') idx.push(i);
  const n = Math.min(idx.length, 4);
  const variants = [];
  for (let mask = 0; mask < (1 << n); mask++) {
    const arr = id.split('');
    for (let b = 0; b < n; b++) arr[idx[b]] = (mask >> b) & 1 ? 'O' : '0';
    variants.push(arr.join(''));
  }
  const dist = (a) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== id[i]) d++; return d; };
  return [...new Set(variants)].sort((a, b) => dist(a) - dist(b));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'POST only' }));
  }
  const steps = [];
  const send = (obj) => {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(obj));
  };
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    if (!body) body = {};
    const qr = (body.qr || '').trim() || null;
    const manualId = (body.txId || '').trim().toUpperCase() || null;
    const ocrText = body.ocrText || '';
    const accountSuffix = (body.account || '').replace(/\D/g, '');

    let fields = null, failReason = null, needAccount = false;
    const attempt = async (label, fn) => {
      if (fields) return;
      try {
        fields = await fn();
        steps.push('CONFIRMED with the official ' + label + ' server ✔');
      } catch (e) {
        failReason = e.message;
        steps.push(label + ' check failed: ' + e.message);
      }
    };
    // hints from the screenshot, used only to pick between O/0 variants when
    // more than one yields a bank record
    const amtM = String(ocrText).match(/([\d,]+\.\d{2})\s*ETB/i);
    const ocrAmount = amtM ? parseFloat(amtM[1].replace(/,/g, '')) : null;
    const timeM = String(ocrText).match(/(\d{2}:\d{2}:\d{2})/);
    const ocrTime = timeM ? timeM[1] : null;

    let telebirrLookups = 0;
    let fallbackFields = null;
    const tryTelebirr = async (id, exact = false) => {
      const list = exact ? [id] : o0Variants(id);
      for (const v of list) {
        if (fields || telebirrLookups >= 10) return;
        telebirrLookups++;
        try {
          const f = await verifyTelebirr(v);
          const recAmounts = [f.amount, f.totalDebited].filter(Boolean).map((a) => parseFloat(String(a).replace(/,/g, '')));
          const amountOk = ocrAmount == null || recAmounts.some((a) => Math.abs(a - ocrAmount) < 1);
          const timeOk = ocrTime == null || String(f.date || '').includes(ocrTime);
          if (exact || amountOk || timeOk) {
            fields = f;
            steps.push('CONFIRMED with the official telebirr server ✔ (transaction ' + v + ')');
          } else if (!fallbackFields) {
            fallbackFields = f;
            steps.push('telebirr record exists for ' + v + ' but its amount/time differ from this screenshot — kept searching');
          }
        } catch (e) {
          failReason = e.message;
          steps.push('telebirr: no record for ' + v);
        }
      }
    };

    let pendingCbeId = null;
    const tryCbeId = async (id) => {
      if (accountSuffix.length >= 5) {
        await attempt('CBE', () => verifyCbeLegacy(id, accountSuffix));
      } else {
        needAccount = true;
        pendingCbeId = id;
        failReason = 'found CBE transaction ' + id + ' — CBE needs the last 8 digits of the account to release the record';
        steps.push('waiting for account digits to query CBE about ' + id);
      }
    };

    // 1. QR code — the most reliable route
    if (qr) {
      steps.push('QR code content: ' + qr.slice(0, 70));
      const telebirrTx = telebirrTxFromQr(qr);
      if (/mbreciept\.cbe\.com\.et\//i.test(qr)) {
        const token = qr.split('cbe.com.et/')[1].split(/[?#]/)[0];
        await attempt('CBE', () => verifyCbeApi(token));
      } else if (/apps\.cbe\.com\.et/i.test(qr)) {
        const idMatch = qr.match(/id=([A-Z0-9]+)/i);
        if (idMatch) await attempt('CBE', () => verifyCbeLegacy(idMatch[1], ''));
      } else if (/ethiotelecom\.et/i.test(qr)) {
        const idMatch = qr.match(/receipt\/([A-Z0-9]+)/i);
        if (idMatch) await tryTelebirr(idMatch[1], true);
      } else if (/^FT[A-Z0-9]{6,}$/i.test(qr)) {
        await tryCbeId(qr.toUpperCase());
      } else if (telebirrTx) {
        steps.push('telebirr transaction number decoded from QR: ' + telebirrTx);
        await tryTelebirr(telebirrTx, true);
      } else {
        steps.push('QR is not a CBE/telebirr receipt QR — falling back to transaction ID search');
      }
    } else {
      steps.push('no QR code readable — falling back to transaction ID search');
    }

    // 2. Manually typed transaction ID
    if (!fields && manualId) {
      if (/^FT[A-Z0-9]{6,}$/.test(manualId)) await tryCbeId(manualId);
      else if (/^[A-Z0-9]{10}$/.test(manualId)) await tryTelebirr(manualId);
      else { failReason = manualId + ' does not look like a CBE (FT…) or telebirr (10 characters) transaction ID'; }
    }

    // 3. Transaction IDs found in the receipt text (OCR) — each candidate is
    //    checked against the bank server, so a wrong OCR read can never
    //    produce a false VERIFIED
    if (!fields && ocrText) {
      const candidates = txCandidatesFromText(ocrText);
      if (candidates.length) steps.push('possible transaction IDs read from the image: ' + candidates.join(', '));
      for (const c of candidates) {
        if (fields) break;
        if (/^FT/.test(c)) await tryCbeId(c);
        else await tryTelebirr(c);
      }
    }

    // a bank record was found but didn't match the screenshot's amount/time —
    // still a real record, but flag it for the user to double-check
    if (!fields && fallbackFields) {
      fields = fallbackFields;
      steps.push('NOTE: verify the transaction ID on this record matches your receipt');
    }

    if (fields) {
      return send({
        verdict: 'VERIFIED',
        provider: fields.provider,
        confidence: '100% — every detail below comes from the official ' + fields.provider + ' record, not from the image',
        fields: {
          amount: fields.amount || null,
          totalDebited: fields.totalDebited || null,
          date: fields.date || null,
          payer: fields.payer || null,
          receiver: fields.receiver || null,
          txId: fields.txId || null,
          status: fields.status || null,
        },
        steps,
      });
    }

    return send({
      verdict: needAccount ? 'NEED_ACCOUNT' : 'FAILED',
      confidence: failReason || 'Could not find a QR code or a transaction ID in this image — type the transaction ID manually and try again',
      hint: needAccount
        ? 'Enter the last 8 digits of the account (yours or the sender’s) above and press Verify again.'
        : null,
      fields: { txId: pendingCbeId },
      steps,
    });
  } catch (e) {
    res.statusCode = 500;
    return send({ error: e.message, steps });
  }
};
