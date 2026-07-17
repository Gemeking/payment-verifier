// Relay job queue: lets an "agent" script running inside Ethiopia fetch
// telebirr receipts that the hosting region cannot reach. The agent
// long-polls GET /relay/poll for jobs and POSTs the fetched HTML back to
// /relay/result. Everything lives in memory on this single instance.
const KEY = process.env.RELAY_KEY || 'gemeking-relay-2026';

let lastPoll = 0;
let seq = 0;
const jobs = [];               // jobs waiting for an agent
const jobWaiters = [];         // agent polls waiting for a job
const resultWaiters = new Map(); // jobId -> { resolve, reject, timer }

function agentOnline() {
  return Date.now() - lastPoll < 60 * 1000;
}

// called by the agent's long-poll; resolves with a job or null after ms
function waitForJob(ms) {
  lastPoll = Date.now();
  if (jobs.length) return Promise.resolve(jobs.shift());
  return new Promise((resolve) => {
    const w = {
      resolve,
      timer: setTimeout(() => {
        const i = jobWaiters.indexOf(w);
        if (i >= 0) jobWaiters.splice(i, 1);
        resolve(null);
      }, ms),
    };
    jobWaiters.push(w);
  });
}

// called by the verifier; resolves with the page HTML fetched in Ethiopia
function fetchViaRelay(url, ms = 15000) {
  if (!agentOnline()) return Promise.reject(new Error('relay agent offline'));
  const jobId = 'j' + (++seq) + '-' + Date.now();
  const job = { jobId, url };
  const w = jobWaiters.shift();
  if (w) {
    clearTimeout(w.timer);
    w.resolve(job);
  } else {
    jobs.push(job);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resultWaiters.delete(jobId);
      reject(new Error('relay timeout'));
    }, ms);
    resultWaiters.set(jobId, { resolve, reject, timer });
  });
}

function submitResult(jobId, payload) {
  const w = resultWaiters.get(jobId);
  if (!w) return;
  clearTimeout(w.timer);
  resultWaiters.delete(jobId);
  if (payload && payload.ok && typeof payload.body === 'string') w.resolve(payload.body);
  else w.reject(new Error('relay fetch failed'));
}

module.exports = { KEY, agentOnline, waitForJob, fetchViaRelay, submitResult };
