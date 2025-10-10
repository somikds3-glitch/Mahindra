// api/news.js — Fixed for NewsData.io (archive/latest + nextPage)
// Keep your ENV var: NEWS_API_KEY

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function jsonResponse(res, obj, status = 200) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');
  res.status(status).send(JSON.stringify(obj));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return jsonResponse(res, { error: 'Only POST allowed' }, 405);

  const NEWS_KEY = process.env.NEWS_API_KEY;
  if (!NEWS_KEY) return jsonResponse(res, { error: 'Server missing NEWS_API_KEY' }, 500);

  let body = req.body;
  if (!body || typeof body !== 'object') {
    try { body = JSON.parse(req.body || '{}'); } catch { return jsonResponse(res, { error: 'Invalid JSON body' }, 400); }
  }

  // inputs
  let companies = Array.isArray(body.companies) ? body.companies : (body.companies || '');
  if (typeof companies === 'string') companies = companies.split(',').map(s => s.trim()).filter(Boolean);
  companies = (companies || []).filter(Boolean);
  if (!companies.length) return jsonResponse(res, { error: 'No companies provided' }, 400);

  const from = body.from || null;  // yyyy-mm-dd
  const to   = body.to   || null;  // yyyy-mm-dd
  const pagesPerCompany = Math.max(1, Math.min(6, parseInt(body.pagesPerCompany || 2, 10) || 2));
  const useArchive = Boolean(from || to);

  const BASE = useArchive ? 'https://newsdata.io/api/1/archive' : 'https://newsdata.io/api/1/latest';
  const all = [];

  try {
    for (const company of companies) {
      let pageToken = null;
      let pages = 0;

      while (pages < pagesPerCompany) {
        const url = new URL(BASE);
        url.searchParams.set('apikey', NEWS_KEY);
        url.searchParams.set('q', company);
        url.searchParams.set('language', 'en');

        if (useArchive) {
          if (from) url.searchParams.set('from_date', from);
          if (to)   url.searchParams.set('to_date', to);
        }
        if (pageToken) url.searchParams.set('page', pageToken);

        const r = await fetch(url.toString());
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          throw new Error(`News API error ${r.status}: ${text}`);
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
    return jsonResponse(res, { error: err.message || String(err) }, 502);
  }

  // dedupe by URL, then normalized title/desc
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

  const unique = Array.from(byUrl.values());
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

  final.sort((x,y) => (Date.parse(y.publishedAt || '') || 0) - (Date.parse(x.publishedAt || '') || 0));
  return jsonResponse(res, final, 200);
}
