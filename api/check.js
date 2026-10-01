const vm = require("node:vm");
const https = require("node:https");
const ts = require("typescript");

const CATALOG_URL = "https://raw.githubusercontent.com/Seanime-contributions/Seanime-Providers/main/marketplace/main.json";
const DEFAULT_QUERY = "One Piece";
const MAX_QUERY_LENGTH = 80;
const REQUEST_TIMEOUT_MS = 8000;
const OPERATION_TIMEOUT_MS = 9000;
const MAX_CONCURRENCY = 12;
const CONTENT_TYPES = new Set(["onlinestream-provider", "manga-provider", "anime-torrent-provider"]);

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function request(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(url, label) {
  const response = await request(url);
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return response.json();
}

async function readText(url, label) {
  const response = await request(url);
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return response.text();
}

function normalizeQuery(value) {
  const query = String(value || DEFAULT_QUERY).trim().replace(/\s+/g, " ");
  return (query || DEFAULT_QUERY).slice(0, MAX_QUERY_LENGTH);
}

function providerTypeLabel(type) {
  return ({
    "onlinestream-provider": "Anime",
    "manga-provider": "Manga",
    "anime-torrent-provider": "Torrent",
  })[type] || type;
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/g, "remote endpoint").slice(0, 220);
}

function loadProvider(source, sourceUrl) {
  let code = source;
  if (/\.tsx?([?#]|$)/i.test(sourceUrl)) {
    code = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
      fileName: sourceUrl,
    }).outputText;
  }

  const quietConsole = { log() {}, info() {}, warn() {}, error() {} };
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console: quietConsole,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    AbortController,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    fetch: (url, options) => request(url, options),
  };
  vm.runInNewContext(`${code}\nmodule.exports = Provider;`, sandbox, { filename: sourceUrl, timeout: 2500 });
  if (typeof sandbox.module.exports !== "function") throw new Error("Provider payload did not define a Provider class");
  return sandbox.module.exports;
}

async function checkProvider(item, query) {
  const startedAt = Date.now();
  const result = {
    id: item.id,
    name: item.name || item.id,
    type: providerTypeLabel(item.type),
    author: item.author || "Unknown",
    status: "down",
    phase: "manifest",
    message: "Not checked",
    durationMs: 0,
  };

  try {
    const manifest = await readJson(item.manifestURI, "Manifest");
    result.version = manifest.version || item.version || "—";
    result.language = manifest.lang || item.lang || "—";
    result.phase = "payload";
    if (!manifest.payloadURI) throw new Error("Manifest has no payloadURI");

    const payloadUrl = new URL(manifest.payloadURI, item.manifestURI).toString();
    const payload = await readText(payloadUrl, "Payload");
    const Provider = loadProvider(payload, payloadUrl);
    const provider = new Provider();
    const settings = typeof provider.getSettings === "function" ? await withTimeout(Promise.resolve(provider.getSettings()), OPERATION_TIMEOUT_MS, "getSettings") : {};
    result.servers = settings?.episodeServers || [];
    result.phase = "search";

    if (typeof provider.search !== "function") throw new Error("Provider has no search method");
    const input = {
      query,
      opts: { query, dub: false },
      media: { id: 0, title: query, synonyms: [], isAdult: false },
      dub: false,
      year: undefined,
    };
    const matches = await withTimeout(Promise.resolve(provider.search(input)), OPERATION_TIMEOUT_MS, "search");
    if (!Array.isArray(matches) || matches.length === 0) {
      result.status = "warning";
      result.message = "Search returned no results";
      return result;
    }
    result.match = matches[0]?.title || matches[0]?.name || query;
    result.phase = "content";

    const firstMatch = matches[0];
    let entries;
    if (item.type === "manga-provider") {
      if (typeof provider.findChapters !== "function") throw new Error("Provider has no findChapters method");
      entries = await withTimeout(Promise.resolve(provider.findChapters(firstMatch.id)), OPERATION_TIMEOUT_MS, "findChapters");
    } else {
      if (typeof provider.findEpisodes !== "function") throw new Error("Provider has no findEpisodes method");
      entries = await withTimeout(Promise.resolve(provider.findEpisodes(firstMatch.id)), OPERATION_TIMEOUT_MS, "findEpisodes");
    }
    if (!Array.isArray(entries) || entries.length === 0) throw new Error("Search succeeded but no content entries were returned");
    result.entries = entries.length;

    // A source-resolution call is intentionally not required for a green result:
    // it can trigger anti-bot checks or consume a media stream. Search + content
    // discovery is the stable health signal for a public detector.
    result.status = "up";
    result.phase = "complete";
    result.message = `Search and ${item.type === "manga-provider" ? "chapter" : "episode"} discovery succeeded`;
  } catch (error) {
    result.status = /timed out/i.test(String(error?.message)) ? "timeout" : "down";
    result.message = errorMessage(error);
  } finally {
    result.durationMs = Date.now() - startedAt;
  }
  return result;
}

async function mapWithConcurrency(items, worker, limit) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Cache-Control", "no-store");
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const query = normalizeQuery(body.query || req.query?.query);
  try {
    const catalog = await readJson(CATALOG_URL, "Marketplace catalog");
    const items = (Array.isArray(catalog) ? catalog : []).filter(item => CONTENT_TYPES.has(item?.type));
    const results = await mapWithConcurrency(items, item => checkProvider(item, query), MAX_CONCURRENCY);
    const summary = results.reduce((counts, item) => { counts[item.status] = (counts[item.status] || 0) + 1; return counts; }, {});
    return res.status(200).json({ query, checkedAt: new Date().toISOString(), total: results.length, summary, results });
  } catch (error) {
    return res.status(502).json({ query, error: errorMessage(error) });
  }
};
