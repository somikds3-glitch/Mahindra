// api/news.js - Vercel Serverless function for news aggregation + dedupe
// Deploy on Vercel. Set environment variable NEWS_API_KEY in Project Settings.

const NEWS_API_BASE = 'https://newsdata.io/api/1/news';

// helper: normalize text for dedupe
function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// helper: safe json response with CORS
function jsonResponse(res, obj, status = 200) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.send(JSON.stringify(obj));
}

// Express-like handler for Vercel
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return jsonResponse(res, {}, 204);
  }
  if (req.method !== 'POST') {
    return jsonResponse(res, { error: 'Only POST allowed' }, 405);
  }

  const NEWS_KEY = process.env.NEWS_API_KEY;
  if (!NEWS_KEY) return jsonResponse(res, { error: 'Server missing NEWS_API_KEY' }, 500);

  let body;
  try {
    body = req.body;
    // If content-type isn't JSON, try parsing raw
    if (!body || typeof body !== 'object') {
      body = JSON.parse(req.body || '{}');
    }
  } catch (e) {
    return jsonResponse(res, { error: 'Invalid JSON body' }, 400);
  }

  // parse inputs
  let companies = Array.isArray(body.companies) ? body.companies : (body.companies || '');
  if (typeof companies === 'string') companies = companies.split(',').map(s => s.trim()).filter(Boolean);
  companies = (companies || []).map(s => s).filter(Boolean);
  if (!companies.length) return jsonResponse(res, { error: 'No companies provided' }, 400);

  const from = body.from || null;
  const to = body.to || null;
  const pagesPerCompany = Math.max(1, Math.min(5, parseInt(body.pagesPerCompany || 2, 10) || 2)); // cap at 5
  const pageSize = Math.max(1, Math.min(50, parseInt(body.pageSize || 20, 10) || 20));

  const all = [];

  // sequential fetch to be gentle on free API
  try {
    for (const company of companies) {
      for (let p = 1; p <= pagesPerCompany; p++) {
        const url = new URL(NEWS_API_BASE);
        url.searchParams.set('apikey', NEWS_KEY);
        url.searchParams.set('q', company);
        if (from) url.searchParams.set('from', from);
        if (to) url.searchParams.set('to', to);
        url.searchParams.set('page', String(p));
        url.searchParams.set('language', 'en');

        const r = await fetch(url.toString());
        if (!r.ok) {
          const txt = await r.text().catch(()=>'');
          throw new Error(`News API error ${r.status}: ${txt}`);
        }
        const j = await r.json();
        const items = j.results || j.articles || [];
        if (!items || items.length === 0) break;
        for (const a of items) {
          const title = a.title || a.title_no_formatting || '';
          const urlField = a.link || a.url || (a.source && a.source.url) || '';
          const source = a.source_id || (a.source && a.source.name) || '';
          const publishedAt = a.pubDate || a.publishedAt || a.pubdate || '';
          const description = a.description || a.summary || a.snippet || '';
          all.push({ title, url: urlField, source, publishedAt, description, companyQueried: company });
        }
      }
    }
  } catch (err) {
    return jsonResponse(res, { error: err.message || String(err) }, 502);
  }

  // Deduplicate by URL then normalized title
  const byUrl = new Map();
  for (const a of all) {
    if (a.url) {
      if (!byUrl.has(a.url)) byUrl.set(a.url, { ...a });
      else {
        const ex = byUrl.get(a.url);
        ex.companyQueried = Array.from(new Set((ex.companyQueried + ',' + a.companyQueried).split(',').map(s=>s.trim()).filter(Boolean))).join(',');
      }
    } else {
      const key = 'no-url|' + normalize(a.title || a.description || '');
      if (!byUrl.has(key)) byUrl.set(key, { ...a });
      else {
        const ex = byUrl.get(key);
        ex.companyQueried = Array.from(new Set((ex.companyQueried + ',' + a.companyQueried).split(',').map(s=>s.trim()).filter(Boolean))).join(',');
      }
    }
  }

  let unique = Array.from(byUrl.values());
  const seen = new Map();
  const final = [];
  for (const a of unique) {
    const n = normalize(a.title || a.description || '');
    if (!n) { final.push(a); continue; }
    if (!seen.has(n)) { seen.set(n, a); final.push(a); }
    else {
      const ex = seen.get(n);
      ex.companyQueried = Array.from(new Set((ex.companyQueried + ',' + a.companyQueried).split(',').map(s=>s.trim()).filter(Boolean))).join(',');
    }
  }

  // sort newest first
  final.sort((x,y) => (Date.parse(y.publishedAt || '') || 0) - (Date.parse(x.publishedAt || '') || 0));

  return jsonResponse(res, final, 200);
}
