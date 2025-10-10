// api/news.js — strict & fixed for NewsData.io
// Requires: process.env.NEWS_API_KEY

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function send(res, status, obj) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');
  res.status(status).send(JSON.stringify(obj));
}

function isYYYYMMDD(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return send(res, 405, { error: 'Only POST allowed' });

  const NEWS_KEY = process.env.NEWS_API_KEY;
  if (!NEWS_KEY) return send(res, 500, { error: 'Server missing NEWS_API_KEY' });

  let body = req.body;
  if (!body || typeof body !== 'object') {
    try { body = JSON.parse(req.body || '{}'); }
    catch { return send(res, 400, { error: 'Invalid JSON body' }); }
  }

  // 1) Inputs
  let companies = Array.isArray(body.companies) ? body.companies : (body.companies || '');
  if (typeof companies === 'string') companies = companies.split(',').map(s => s.trim()).filter(Boolean);
  companies = (companies || []).filter(Boolean);
  if (!companies.length) return send(res, 400, { error: 'No companies provided' });

  const from = body.from || null;   // yyyy-mm-dd
  const to   = body.to   || null;   // yyyy-mm-dd
  const pagesPerCompany = Math.max(1, Math.min(6, parseInt(body.pagesPerCompany || 2, 10) || 2));

  // 2) Validate dates and select endpoint
  let base = 'https://newsdata.io/api/1/latest';
  let useArchive = false;
  if (from || to) {
    if (!(from && to)) {
      return send(res, 400, { error: 'Both from and to are required together for archive searches (YYYY-MM-DD).' });
    }
    if (!isYYYYMMDD(from) || !isYYYYMMDD(to)) {
      return send(res, 400, { error: 'Dates must be in YYYY-MM-DD format.' });
    }
    useArchive = true;
    base = 'https://newsdata.io/api/1/archive';
  }

  const all = [];

  try {
    for (const company of companies) {
      let pageToken = null;
      let pages = 0;

      while (pages < pagesPerCompany) {
        const url = new URL(base);
        url.searchParams.set('apikey', NEWS_KEY);
        url.searchParams.set('q', company);
        url.searchParams.set('language', 'en'); // Supported param

        if (useArchive) {
          url.searchParams.set('from_date', from);
          url.searchParams.set('to_date', to);
        }
        if (pageToken) url.searchParams.set('page', pageToken); // only when token exists

        const reqUrl = url.toString();
        const r = await fetch(reqUrl);
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          // Surface the exact request minus your key for easier debugging
          const safe = reqUrl.replace(/apikey=[^&]+/, 'apikey=***');
          throw new Error(`News API error ${r.status} for ${safe}: ${text}`);
        }

        const j = await r.json();
        const items = j.results || j.articles || [];
        for (const a of (items || [])) {
          const title = a.title || a.title_no_formatting || '';
          const urlField = a.link || a.url || (a.source && a.source.url) || '';
          const source = a.source_id || (a.source && a.source.name) || '';
          const publishedAt = a.pubDate || a.publishedAt || a.pubdate || '';
          const description = a.description || a.summary || a.snippet || '';
          all.push({ title, url: urlField, source, publishedAt, description, companyQueried: company });
        }

        pages += 1;
        pageToken = j.nextPage || null;
        if (!pageToken) break;
      }
    }
  } catch (err) {
    return send(res, 502, { error: String(err.message || err) });
  }

  // 3) Deduplicate
  const byUrl = new Map();
  for (const a of all) {
    if (a.url) {
      if (!byUrl.has(a.url)) byUrl.set(a.url, { ...a });
      else {
        const ex = byUrl.get(a.url);
        ex.companyQueried = Array.from(new Set((ex.companyQueried + ',' + a.companyQueried).split(',').map(s => s.trim()).filter(Boolean))).join(',');
      }
    } else {
      const key = 'no-url|' + normalize(a.title || a.description || '');
      if (!byUrl.has(key)) byUrl.set(key, { ...a });
      else {
        const ex = byUrl.get(key);
        ex.companyQueried = Array.from(new Set((ex.companyQueried + ',' + a.companyQueried).split(',').map(s => s.trim()).filter(Boolean))).join(',');
      }
    }
  }

  const unique = Array.from(byUrl.values());
  const seen = new Map();
  const final = [];
  for (const a of unique) {
    const n = normalize(a.title || a.description || '');
    if (!n) { final.push(a); continue; }
    if (!seen.has(n)) { seen.set(n, a); final.push(a); }
    else {
      const ex = seen.get(n);
      ex.companyQueried = Array.from(new Set((ex.companyQueried + ',' + a.companyQueried).split(',').map(s => s.trim()).filter(Boolean))).join(',');
    }
  }
  final.sort((x, y) => (Date.parse(y.publishedAt || '') || 0) - (Date.parse(x.publishedAt || '') || 0));
  return send(res, 200, final);
}