// functions/api/trivia.js
// Fast, hybrid + cached Trivia API for Cloudflare Pages Functions / Workers
// - Time-boxed LLM calls with instant fallback
// - Edge cache by (category,difficulty)
// - In-memory “hybrid” pool per category for instant first-byte
// - Simpler validation + fewer retries
// - Debug headers + forceGen flag to bypass fallbacks and test generation

// Use the external fallback bank (JS module placed at functions/api/_shared/fallbackQuestions.js)
import STATIC_PREBUILT from './_shared/fallbackQuestions.js';

// ===== In-memory HYBRID POOLS (per isolate) =====
// NOTE: These reset when the isolate is recycled. For persistence across POPs, bind KV/R2 and replace this with real storage.
const POOL_SIZE = 6; // per (category,difficulty)
const HYBRID_POOLS = new Map(); // key: `${category}:${difficulty}` -> Array<question>

function poolKey(category, difficulty) {
  return `${category}:${difficulty}`;
}
function getPool(category, difficulty) {
  const key = poolKey(category, difficulty);
  if (!HYBRID_POOLS.has(key)) HYBRID_POOLS.set(key, []);
  return HYBRID_POOLS.get(key);
}
function poolPop(category, difficulty) {
  const pool = getPool(category, difficulty);
  return pool.length ? pool.shift() : null;
}
function poolPush(category, difficulty, q) {
  const pool = getPool(category, difficulty);
  // very light duplicate guard by question text
  if (!pool.some(x => (x.question || "").trim() === (q.question || "").trim())) {
    pool.push(q);
    while (pool.length > POOL_SIZE) pool.shift();
  }
}

// ===== Helpers =====
const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const edgeCacheTTL = 120; // seconds
const edgeStale = 60;     // seconds
const GEN_TIMEOUT_MS = 1500; // time-box each LLM attempt
const MAX_TRIES = 3;         // fewer retries than before

// ===== Models =====
// For debugging, run everything on a known-fast model.
// Once working, you can switch medium/hard back to larger models if desired.
const MODEL_MAP = {
  easy:   "@cf/meta/llama-3.2-1b-instruct",
  medium: "@cf/meta/llama-3.2-1b-instruct",
  hard:   "@cf/meta/llama-3.2-1b-instruct"
};

function raceWithTimeout(promise, ms = GEN_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("gen_timeout")), ms))
  ]);
}

// Rotate through static fallbacks for variety if AI is unavailable
let STATIC_INDEX = 0;
function pickStatic(category, difficulty) {
  const arr =
    STATIC_PREBUILT[`${category}:${difficulty}`] ||
    STATIC_PREBUILT["general:easy"] ||
    [];
  if (!arr.length) return null;
  const q = arr[STATIC_INDEX % arr.length];
  STATIC_INDEX++;
  return structuredClone(q);
}

// Fisher–Yates shuffle
function shuffleInPlace(a, rng = Math.random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}
function finalizeChoices(questionObj, seed) {
  const rng = mulberry32(typeof seed === "number" ? seed : Math.floor(Math.random() * 1e9));
  const originalCorrect = questionObj.choices[questionObj.correct_index];
  shuffleInPlace(questionObj.choices, rng);
  questionObj.correct_index = questionObj.choices.findIndex(x => x === originalCorrect);
  return questionObj;
}
function mulberry32(a) {
  return function() {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Minimal JSON shape validation
function validate(q) {
  if (!q || typeof q !== "object") return false;
  if (typeof q.question !== "string" || q.question.length < 8 || q.question.length > 200) return false;
  if (!Array.isArray(q.choices) || q.choices.length !== 4) return false;
  if (typeof q.correct_index !== "number" || q.correct_index < 0 || q.correct_index > 3) return false;
  if (typeof q.explanation !== "string") q.explanation = "";
  if (typeof q.mode !== "string") q.mode = "definition";
  if (typeof q.answer_text !== "string") q.answer_text = q.choices[q.correct_index];
  if (typeof q.headword !== "string") q.headword = q.answer_text;
  if (typeof q.topic_key !== "string") q.topic_key = "";
  if (typeof q.subject_matter !== "string") q.subject_matter = "general";
  return true;
}

// Quick dedupe against recent headwords/topics/questions
function collidesWithRecent(q, recent = []) {
  const needle = (s) => (s || "").toLowerCase().trim();
  const h = needle(q.headword);
  const t = needle(q.topic_key);
  const qu = needle(q.question);
  return recent.some(r => {
    if (!r) return false;
    const H = needle(r.headword);
    const T = needle(r.topic_key);
    const Q = needle(r.question);
    return (H && H === h) || (T && T === t) || (Q && Q === qu);
  });
}

function makeEdgeCacheKey(category, difficulty) {
  return new Request(`https://trivia.local/q?c=${encodeURIComponent(category)}&d=${encodeURIComponent(difficulty)}`);
}
function buildResponse(payload) {
  return new Response(JSON.stringify(payload), { headers: jsonHeaders });
}

// ===== Debug headers & state =====
let LAST_GEN_ERROR = ""; // last generation error string for quick surface via headers
function withDebugHeaders(resp, srcLabel) {
  try {
    resp.headers.set("X-Trivia-Source", srcLabel);
    if (LAST_GEN_ERROR) resp.headers.set("X-Trivia-Last-Gen-Error", LAST_GEN_ERROR);
  } catch (_) {}
  return resp;
}

// ===== Main handler =====
export const onRequestPost = async (context) => {
  const { request, env } = context;

  // ---------- Read input ----------
  let category = "general";
  let difficulty = "medium";
  let recent = [];
  let seed = Math.floor(Math.random() * 1e9);
  let forceGen = false;

  try {
    const body = await request.json();
    if (typeof body.category === "string") category = body.category;
    if (typeof body.difficulty === "string") difficulty = body.difficulty;
    if (Array.isArray(body.recent)) recent = body.recent.slice(-75);
    if (Number.isInteger(body.seed)) seed = body.seed;
    if (body && body.forceGen === true) forceGen = true;
  } catch (_) {
    // no body is fine
  }

  // ---------- Edge cache first (skip if forceGen) ----------
  if (!forceGen) {
    try {
      const cache = caches.default;
      const key = makeEdgeCacheKey(category, difficulty);
      const cached = await cache.match(key);
      if (cached) {
        const c = new Response(cached.body, cached);
        c.headers.set("cache-control", `public, s-maxage=${edgeCacheTTL}, stale-while-revalidate=${edgeStale}`);
        return withDebugHeaders(c, "edge_cache");
      }
    } catch (_) { /* ignore */ }
  }

  // ---------- Hybrid Pool / Static (skip if forceGen) ----------
  if (!forceGen) {
    let pooled = poolPop(category, difficulty);
    if (!pooled) {
      const staticQ = pickStatic(category, difficulty);
      if (staticQ) pooled = structuredClone(staticQ);
    }
    if (pooled) {
      finalizeChoices(pooled, seed);
      const out = buildResponse({ ...pooled, _src: "pool_or_static" });
      out.headers.set("cache-control", `public, s-maxage=${edgeCacheTTL}, stale-while-revalidate=${edgeStale}`);
      if (typeof context.waitUntil === "function") {
        context.waitUntil(generateAndMaybeCache({ category, difficulty, recent, seed: seed + 7 }, env));
      } else {
        generateAndMaybeCache({ category, difficulty, recent, seed: seed + 7 }, env).catch(()=>{});
      }
      return withDebugHeaders(out, "pool_or_static");
    }
  }

  // ---------- Generate now (forced or fallback) ----------
  const genRes = await generateAndMaybeCache({ category, difficulty, recent, seed }, env, /*eagerPutCache*/ true);
  if (genRes) {
    const out = buildResponse({ ...genRes, _src: forceGen ? "forced_gen" : "fresh_gen" });
    out.headers.set("cache-control", `public, s-maxage=${edgeCacheTTL}, stale-while-revalidate=${edgeStale}`);
    return withDebugHeaders(out, forceGen ? "forced_gen" : "fresh_gen");
  }

  // ---------- Final fallback: static raw (always succeeds) ----------
  const finalQ = pickStatic("general", "easy");
  finalizeChoices(finalQ, seed);
  const out = buildResponse({ ...finalQ, _src: "static_final" });
  out.headers.set("cache-control", `public, s-maxage=${edgeCacheTTL}, stale-while-revalidate=${edgeStale}`);
  return withDebugHeaders(out, "static_final");
};

// ====== Core generation with timeout, validation, edge cache + pool replenish ======
async function generateAndMaybeCache({ category, difficulty, recent, seed }, env, eagerPutCache = false) {
  const MODEL = MODEL_MAP[difficulty] || MODEL_MAP.medium;
  const TEMP = difficulty === "hard" ? 0.6 : 0.65;
  const TOP_P = 0.9;

  const sys = `You generate a single multiple-choice trivia question as strict JSON with fields:
{
  "question": "string (8-180 chars)",
  "choices": ["A","B","C","D"],
  "correct_index": 0-3,
  "explanation": "string <= 200 chars",
  "headword": "short answer headword",
  "mode": "definition|synonym",
  "answer_text": "string",
  "topic_key": "dot.key",
  "subject_matter": "domain"
}
Return ONLY JSON (no markdown, no commentary). Keep language concise. Avoid repeating topics listed in 'recent'.`;

  const user = JSON.stringify({
    category, difficulty,
    constraint: "return ONLY json, no markdown",
    recent: recent.slice(0, 20)
  });

  for (let i = 0; i < MAX_TRIES; i++) {
    try {
      const run = env.AI.run(MODEL, {
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ],
        temperature: TEMP,
        top_p: TOP_P,
        max_tokens: 256,
        seed
      });

      const ai = await raceWithTimeout(run);
      let txt = ai?.response ?? ai?.text ?? "";
      if (typeof txt !== "string") txt = JSON.stringify(ai);

      const jsonStr = extractJson(txt);
      const q = JSON.parse(jsonStr);

      if (!validate(q)) throw new Error("schema_invalid");
      if (collidesWithRecent(q, recent)) throw new Error("collides_recent");

      finalizeChoices(q, seed);

      // Put into pool for future instant serve
      poolPush(category, difficulty, q);

      // Eagerly put into edge cache if requested
      if (eagerPutCache) {
        try {
          const cache = caches.default;
          const key = makeEdgeCacheKey(category, difficulty);
          const cachedRes = new Response(JSON.stringify({ ...q, _src: "edge_cache" }), {
            headers: { "content-type": "application/json; charset=utf-8" }
          });
          cachedRes.headers.set("cache-control", `public, s-maxage=${edgeCacheTTL}, stale-while-revalidate=${edgeStale}`);
          await cache.put(key, cachedRes);
        } catch (_) {}
      }

      return q;
    } catch (err) {
      const msg = `[gen fail] attempt=${i + 1} ${category}/${difficulty} :: ${String(err)}`;
      console.error(msg);
      LAST_GEN_ERROR = msg;
      seed = (seed + 13331) >>> 0;
      if (i === MAX_TRIES - 1) break;
    }
  }

  return null;
}

// Extract a JSON object from a string, even if the model wrapped it
function extractJson(s) {
  const t = s.trim();
  if (t.startsWith("{") && t.endsWith("}")) return t;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return t.slice(start, end + 1);
  }
  return t;
}
