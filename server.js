// Local dev  development server — on Vercel, public/ is served statically and
// api/verify.js runs as a serverless function; this wrapper mimics that.
const express = require('express');
const path = require('path');
const verify = require('./api/verify');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '2mb' }));
app.post('/api/verify', (req, res) => verify(req, res));

app.get('/ping', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3311;
app.listen(PORT, () => console.log('Payment verifier running on http://localhost:' + PORT));

// Render's free tier spins the service down after 15 idle minutes; ping our
// own public URL every 10 minutes to stay awake. RENDER_EXTERNAL_URL is set
// automatically by Render, so this does nothing when running locally.
const selfUrl = process.env.RENDER_EXTERNAL_URL;
if (selfUrl) {
  setInterval(() => {
    fetch(selfUrl + '/ping').catch(() => {});
  }, 10 * 60 * 1000);
  console.log('keep-alive ping enabled for ' + selfUrl);
}
