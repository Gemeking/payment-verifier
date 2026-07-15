// Vercel serverless function: receives { qr, ocrText, account } from the
// browser (which already did QR decoding + OCR locally) and confirms the
// transaction against the official CBE / telebirr servers.
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

function extractFromOcr(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const fields = {};
  let m;
  if ((m = t.match(/ETB\s*([\d,]+\.\d{2})\s*(?:has been\s*)?debited/i))) fields.amount = m[1];
  else if ((m = t.match(/[-—]\s*([\d,]+\.\d{2})\s*\(?\s*[E€][TF1I]?B?\s*\)?/i))) fields.amount = m[1];
  else if ((m = t.match(/(?:Amount|Total Paid|Settled)[^\d]{0,20}([\d,]+\.\d{2})/i))) fields.amount = m[1];
  else if ((m = t.match(/([\d,]+\.\d{2})/))) fields.amount = m[1];

  if ((m = t.match(/(\d{4}\/\d{2}\/\d{2}[ T]\d{2}:\d{2}:\d{2})/))) fields.date = m[1];
  else if ((m = t.match(/([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)/))) fields.date = m[1];
  else if ((m = t.match(/(\d{1,2}-[A-Z][a-z]{2}-\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]M)?)?)/))) fields.date = m[1];

  if ((m = t.match(/\b(FT[A-Z0-9]{8,14})\b/))) fields.txId = m[1];
  else if ((m = t.match(/Transaction (?:Number|No\.?|ID)\s*:?\s*([A-Z0-9]{8,14})\b/i))) fields.txId = m[1];

  if ((m = t.match(/debited from\s+([A-Z][A-Za-z' ]+?)\s+(?:ETB-\d+\s+)?for\s+([A-Z][A-Za-z' ]+?)(?:\s+ETB-?\d+|-ETB-?\d+|\s+on\b)/i))) {
    fields.payer = m[1].trim();
    fields.receiver = m[2].trim();
  }
  if (!fields.receiver && (m = t.match(/Transaction To:?\s*([A-Z][A-Z' ]+[A-Z])/))) fields.receiver = m[1].trim();
  return fields;
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
    fields: {
      provider: 'CBE',
      amount: j.debitAmount || j.amountCredited,
      totalDebited: j.amountDebited,
      date: j.dateTimes && j.dateTimes[0] ? fmtCbeDate(j.dateTimes[0]) : (j.processingDate || null),
      payer: j.debitAccountHolder || null,
      receiver: j.creditAccountHolder || null,
      txId: j.id,
      status: 'Completed (bank record found)',
    },
    compareAmounts: [j.debitAmount, j.amountDebited, j.amountCredited].filter(Boolean),
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
  return { fields, compareAmounts: [fields.amount].filter(Boolean) };
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
  if (!/telebirr/i.test(t)) throw new Error('unexpected reply from the telebirr server');

  const fields = { provider: 'telebirr', txId };
  let m;
  if ((m = t.match(/Payer Name\s+([A-Z][A-Za-z' ]+?)(?=\s*የ|\s*Payer|\s*\/)/i))) fields.payer = m[1].trim();
  if ((m = t.match(/Bank account number\s+(\d{6,})\s+([A-Z][A-Za-z' ]+?)(?=\s*የ|\s*\/|\s*Invoice)/i))) {
    fields.receiver = m[2].trim() + ' (' + m[1] + ')';
  } else if ((m = t.match(/Credited Party name\s+([A-Z][A-Za-z' ]+?)(?=\s*የ|\s*Credited|\s*\/)/i))) {
    fields.receiver = m[1].trim();
  }
  if ((m = t.match(/(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2})/))) fields.date = m[1] + ' (dd-mm-yyyy)';
  if ((m = t.match(/Total Paid Amount\s+([\d,]+(?:\.\d{1,2})?)\s*Birr/i))) fields.amount = m[1];
  let settled = null;
  if ((m = t.match(/([\d,]+(?:\.\d{1,2})?)\s*Birr/i)) && !fields.amount) fields.amount = m[1];
  if ((m = t.match(/Settled Amount\s+[A-Z0-9]{10}\s+[\d-]+\s+[\d:]+\s+([\d,]+(?:\.\d{1,2})?)\s*Birr/i))) settled = m[1];
  if ((m = t.match(/transaction status\s+([A-Za-z]+)/i))) fields.status = m[1];
  if (!fields.amount && !settled) throw new Error('telebirr has no record for transaction ' + txId);
  if (!fields.amount) fields.amount = settled;
  return { fields, compareAmounts: [fields.amount, settled].filter(Boolean) };
}

const num = (s) => parseFloat(String(s).replace(/,/g, ''));

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'POST only' }));
  }
  const steps = [];
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    if (!body) body = {};
    const qr = (body.qr || '').trim() || null;
    const ocrText = body.ocrText || '';
    const accountSuffix = (body.account || '').replace(/\D/g, '');

    const ocrFields = extractFromOcr(ocrText);
    const isTelebirrShot = /telebirr|ethio\s*telecom/i.test(ocrText);
    const looksCbe = /commercial bank of ethiopia|\bCBE\b/i.test(ocrText) || /^FT/i.test(ocrFields.txId || '');

    let online = null, onlineError = null;
    const tryOnline = async (label, fn) => {
      if (online) return;
      try {
        online = await fn();
        steps.push('CONFIRMED with the official ' + label + ' server ✔');
      } catch (e) {
        onlineError = e.message;
        steps.push(label + ' online check failed: ' + e.message);
      }
    };

    const telebirrTx = qr ? telebirrTxFromQr(qr) : null;

    if (qr && /mbreciept\.cbe\.com\.et\//i.test(qr)) {
      const token = qr.split('cbe.com.et/')[1].split(/[?#]/)[0];
      await tryOnline('CBE', () => verifyCbeApi(token));
    } else if (qr && /apps\.cbe\.com\.et/i.test(qr)) {
      const idMatch = qr.match(/id=([A-Z0-9]+)/i);
      if (idMatch) await tryOnline('CBE', () => verifyCbeLegacy(idMatch[1], ''));
    } else if (qr && /ethiotelecom\.et/i.test(qr)) {
      const idMatch = qr.match(/receipt\/([A-Z0-9]+)/i);
      if (idMatch) await tryOnline('telebirr', () => verifyTelebirr(idMatch[1]));
    } else if (qr && /^FT[A-Z0-9]{6,}$/i.test(qr)) {
      if (accountSuffix.length >= 5) {
        await tryOnline('CBE', () => verifyCbeLegacy(qr.toUpperCase(), accountSuffix));
      } else {
        onlineError = 'this CBE receipt needs the last 8 digits of the account to pull the bank record';
        steps.push('QR holds CBE transaction ' + qr + ' — waiting for account digits to verify online');
      }
    } else if (telebirrTx) {
      await tryOnline('telebirr', () => verifyTelebirr(telebirrTx));
    }

    if (!online && ocrFields.txId) {
      if (/^FT/i.test(ocrFields.txId) && accountSuffix.length >= 5) {
        await tryOnline('CBE', () => verifyCbeLegacy(ocrFields.txId.toUpperCase(), accountSuffix));
      } else if (!/^FT/i.test(ocrFields.txId) && (isTelebirrShot || !looksCbe)) {
        await tryOnline('telebirr', () => verifyTelebirr(ocrFields.txId));
      }
    }

    res.setHeader('Content-Type', 'application/json');

    if (online) {
      const f = online.fields;
      const mismatch = [];
      if (ocrFields.amount && online.compareAmounts.length) {
        const shot = num(ocrFields.amount);
        const matchesAny = online.compareAmounts.some((a) => Math.abs(num(a) - shot) < 1);
        if (!matchesAny) mismatch.push(`the picture shows ETB ${ocrFields.amount} but the official record says ETB ${f.amount}`);
      }
      if (ocrFields.txId && f.txId && ocrFields.txId.toUpperCase() !== String(f.txId).toUpperCase()) {
        mismatch.push(`the picture shows transaction ${ocrFields.txId} but the record is ${f.txId}`);
      }
      return res.end(JSON.stringify({
        verdict: mismatch.length ? 'TAMPERED' : 'VERIFIED',
        provider: f.provider,
        confidence: mismatch.length
          ? 'The image does NOT match the official record'
          : '100% — confirmed against the official ' + f.provider + ' record',
        fields: {
          amount: f.amount || null,
          totalDebited: f.totalDebited || null,
          date: f.date || null,
          payer: f.payer || null,
          receiver: f.receiver || null,
          txId: f.txId || null,
          status: f.status || null,
        },
        mismatch,
        steps,
      }));
    }

    if (ocrFields.amount || ocrFields.txId || qr) {
      const needAccount = looksCbe && accountSuffix.length < 5;
      return res.end(JSON.stringify({
        verdict: 'UNVERIFIED',
        provider: looksCbe ? 'CBE' : (isTelebirrShot ? 'telebirr' : 'unknown'),
        confidence: 'Details were read from the image only — NOT confirmed with the bank'
          + (onlineError ? ' (' + onlineError + ')' : ''),
        hint: needAccount
          ? 'Enter the last 8 digits of the account (sender or receiver) above and press Verify again — that lets me pull the official CBE record for a 100% check.'
          : null,
        fields: {
          amount: ocrFields.amount || null,
          date: ocrFields.date || null,
          payer: ocrFields.payer || null,
          receiver: ocrFields.receiver || null,
          txId: ocrFields.txId || (qr && /^FT/i.test(qr) ? qr : null),
        },
        steps,
      }));
    }

    return res.end(JSON.stringify({
      verdict: 'FAILED',
      confidence: 'Could not read a QR code or any transaction details from this image',
      fields: {},
      steps,
    }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: e.message, steps }));
  }
};
