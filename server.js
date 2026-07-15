// Local development server — on Vercel, public/ is served statically and
// api/verify.js runs as a serverless function; this wrapper mimics that.
const express = require('express');
const path = require('path');
const verify = require('./api/verify');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '2mb' }));
app.post('/api/verify', (req, res) => verify(req, res));

const PORT = process.env.PORT || 3311;
app.listen(PORT, () => console.log('Payment verifier running on http://localhost:' + PORT));
