import STATIC_PREBUILT from './fallbackQuestions.json';

// trivia.js — Fast, hybrid + cached Trivia API for Cloudflare Pages Functions / Workers
// - Time-boxed LLM calls with instant fallback
// - Edge cache by (category,difficulty)
// - In-memory “hybrid” pool per category for instant first-byte
// - Simpler validation + fewer retries

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

// A few static prebuilt items as a last-ditch instant fallback (edit/expand as you like)
const STATIC_PREBUILT = {
  "general:easy": [
    {
      question: "Which planet is known as the Red Planet?",
      choices: ["Mars", "Venus", "Jupiter", "Mercury"],
      correct_index: 0,
      explanation: "Iron oxide dust on Mars gives it a reddish color.",
      headword: "Mars",
      mode: "definition",
      answer_text: "Mars",
      topic_key: "space.mars.basics",
      subject_matter: "astronomy"
    },
    {
      question: "What is the largest mammal on Earth?",
      choices: ["African elephant", "Blue whale", "Giraffe", "Hippopotamus"],
      correct_index: 1,
      explanation: "Blue whales can exceed 150 tons.",
      headword: "Blue whale",
      mode: "definition",
      answer_text: "Blue whale",
      topic_key: "biology.animals.mammals",
      subject_matter: "biology"
    }
  ],
  "general:medium": [
    {
      question: "HTTP status 404 indicates what condition?",
      choices: ["Server error", "Unauthorized", "Not found", "Moved permanently"],
      correct_index: 2,
      explanation: "404 means the requested resource could not be found.",
      headword: "404",
      mode: "definition",
      answer_text: "Not found",
      topic_key: "web.http.codes",
      subject_matter: "computing"
    }
  ],
  "general:hard": [
    {
      question: "Which algorithm provides average-case O(n log n) sorting using divide-and-conquer?",
      choices: ["Bubble sort", "Insertion sort", "Quick sort", "Counting sort"],
      correct_index: 2,
      explanation: "Quicksort partitions and recursively sorts subarrays.",
      headword: "Quicksort",
      mode: "definition",
      answer_text: "Quick sort",
      topic_key: "cs.algorithms.sorting",
      subject_matter: "computer science"
    }
  ]
};

// ===== Helpers =====
const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store" // final cache-control is set on the Response we return
};

const edgeCacheTTL = 120; // seconds
const edgeStale = 60;     // seconds
const GEN_TIMEOUT_MS = 1500; // time-box each LLM attempt
const MAX_TRIES = 3;         // fewer retries than before

// Smaller / faster models
const MODEL_MAP = {
  easy:   "@cf/meta/llama-3.1-8b-instruct",
  medium: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  hard:   "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b"
};

function raceWithTimeout(promise, ms = GEN_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("gen_timeout")), ms))
  ]);
}

function pickStatic(category, difficulty) {
  const arr = STATIC_PREBUILT[`${category}:${difficulty}`] || STATIC_PREBUILT["general:easy"] || [];
  if (!arr.length) return null;
  // return random
  return arr[Math.floor(Math.random() * arr.length)];
}

// Fisher–Yates shuffle (to randomize answer positions reliably)
function shuffleInPlace(a, rng = Math.random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function finalizeChoices(questionObj, seed) {
  // re-index correct answer after shuffle for extra randomness client can't predict
  const rng = mulberry32(typeof seed === "number" ? seed : Math.floor(Math.random() * 1e9));
  const originalCorrect = questionObj.choices[questionObj.correct_index];
  shuffleInPlace(questionObj.choices, rng);
  questionObj.correct_index = questionObj.choices.findIndex(x => x === originalCorrect);
  return questionObj;
}

// small deterministic RNG for shuffle based on seed
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
  const res = new Response(JSON.stringify(payload), { headers: jsonHeaders });
  // NOTE: we set cache headers on the cloned response we return from the handler instead
  return res;
}

// ===== Main handler =====
export const onRequestPost = async (context) => {
  const { request, env } = context;

  // ---------- Read input ----------
  let category = "general";
  let difficulty = "medium";
  let recent = [];
  let seed = Math.floor(Math.random() * 1e9);

  try {
    const body = await request.json();
    if (typeof body.category === "string") category = body.category;
    if (typeof body.difficulty === "string") difficulty = body.difficulty;
    if (Array.isArray(body.recent)) recent = body.recent.slice(-75);
    if (Number.isInteger(body.seed)) seed = body.seed;
  } catch (_) {
    // no body is fine
  }

  // ---------- Edge cache first ----------
  try {
    const cache = caches.default;
    const key = makeEdgeCacheKey(category, difficulty);
    const cached = await cache.match(key);
    if (cached) {
      // fast path from edge
      const c = new Response(cached.body, cached);
      c.headers.set("cache-control", `public, s-maxage=${edgeCacheTTL}, stale-while-revalidate=${edgeStale}`);
      return c;
    }
  } catch (_) {
    // ignore caching errors
  }

  // ---------- Hybrid Pool: instant serve if available ----------
  let pooled = poolPop(category, difficulty);
  if (!pooled) {
    // seed from tiny static set if pool empty
    const staticQ = pickStatic(category, difficulty);
    if (staticQ) pooled = structuredClone(staticQ);
  }
  if (pooled) {
    // slight randomization on output
    finalizeChoices(pooled, seed);
    const out = buildResponse({ ...pooled, _src: "pool_or_static" });
    // set public cache so subsequent users also get something quick
    out.headers.set("cache-control", `public, s-maxage=${edgeCacheTTL}, stale-while-revalidate=${edgeStale}`);
    // Replenish pool in background
    if (typeof context.waitUntil === "function") {
      context.waitUntil(generateAndMaybeCache({ category, difficulty, recent, seed: seed + 7 }, env));
    } else {
      // fire-and-forget best effort
      generateAndMaybeCache({ category, difficulty, recent, seed: seed + 7 }, env).catch(()=>{});
    }
    return out;
  }

  // ---------- No pool? Try to generate now, time-boxed with fallback ----------
  const genRes = await generateAndMaybeCache({ category, difficulty, recent, seed }, env, /*eagerPutCache*/ true);
  if (genRes) {
    const out = buildResponse({ ...genRes, _src: "fresh_gen" });
    out.headers.set("cache-control", `public, s-maxage=${edgeCacheTTL}, stale-while-revalidate=${edgeStale}`);
    return out;
  }

  // ---------- Final fallback: static raw (always succeeds) ----------
  const finalQ = pickStatic("general", "easy");
  finalizeChoices(finalQ, seed);
  const out = buildResponse({ ...finalQ, _src: "static_final" });
  out.headers.set("cache-control", `public, s-maxage=${edgeCacheTTL}, stale-while-revalidate=${edgeStale}`);
  return out;
};

// ====== Core generation with timeout, validation, edge cache + pool replenish ======
async function generateAndMaybeCache({ category, difficulty, recent, seed }, env, eagerPutCache = false) {
  const MODEL = MODEL_MAP[difficulty] || MODEL_MAP.medium;
  const TEMP = difficulty === "hard" ? 0.6 : 0.65;
  const TOP_P = 0.9;

  // Prompt kept compact for speed; you can expand with few-shot if quality dips.
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
Keep language concise. Avoid repeating the same topic as user 'recent'.`;

  const user = JSON.stringify({
    category, difficulty,
    constraint: "return ONLY json, no markdown",
    recent: recent.slice(0, 20) // just a taste to avoid heavy payloads
  });

  // up to MAX_TRIES time-boxed attempts
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

      // try to extract JSON
      const jsonStr = extractJson(txt);
      const q = JSON.parse(jsonStr);

      if (!validate(q)) throw new Error("schema_invalid");
      if (collidesWithRecent(q, recent)) throw new Error("collides_recent");

      // shuffle answers deterministically by seed
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
      // if timeout, try again w/ new seed (fast backoff)
      seed = (seed + 13331) >>> 0;
      // On final iteration, break
      if (i === MAX_TRIES - 1) break;
    }
  }

  // Couldn’t generate now
  return null;
}

// Extract a JSON object from a string, even if the model wrapped it
function extractJson(s) {
  // Fast path: starts with { and ends with }
  const t = s.trim();
  if (t.startsWith("{") && t.endsWith("}")) return t;

  // Try to find first {...} block
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return t.slice(start, end + 1);
  }
  // Fallback to treating the whole thing as JSON (will throw if invalid)
  return t;
}
