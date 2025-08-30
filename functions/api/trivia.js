// functions/api/trivia.js
// Cloudflare Pages Function (POST) — Trivia question generator with
// robust logging, timeouts, hybrid in-memory pool, fallback bank, and debug headers.

// --- Optional external fallback bank (uncomment if you keep one next to this file) ---
// import STATIC_PREBUILT from "../_shared/fallbackQuestions.js";

const STATIC_PREBUILT = [
  {
    question: "What is the capital of France?",
    choices: ["Paris", "Lyon", "Marseille", "Nice"],
    correct_index: 0,
    explanation: "Paris has been the capital of France since 508 CE (with interruptions).",
    headword: "Paris",
    mode: "definition",
    answer_text: "Paris",
    topic_key: "geography",
    subject_matter: "general"
  },
  {
    question: "HTTP stands for…?",
    choices: ["HyperText Transfer Protocol", "High Transfer Text Protocol", "Hyperlink Transfer Text Protocol", "HyperText Transit Protocol"],
    correct_index: 0,
    explanation: "HTTP is the application-layer protocol of the web.",
    headword: "HTTP",
    mode: "definition",
    answer_text: "HyperText Transfer Protocol",
    topic_key: "web",
    subject_matter: "technology"
  },
  {
    question: "Which planet is known as the Red Planet?",
    choices: ["Mars", "Venus", "Jupiter", "Mercury"],
    correct_index: 0,
    explanation: "Mars appears reddish due to iron oxide on its surface.",
    headword: "Mars",
    mode: "definition",
    answer_text: "Mars",
    topic_key: "space",
    subject_matter: "science"
  }
];

// ===== In-memory HYBRID POOLS (per isolate) =====
// NOTE: These reset when the isolate is recycled. For persistence across POPs,
// bind KV/R2 and replace this with real storage.
const POOL_SIZE = 6; // per (category,difficulty)
const HYBRID_POOLS = new Map(); // key: `${category}:${difficulty}` -> Array<question>

function poolKey(category, difficulty) {
  return `${String(category || "general").toLowerCase()}:${String(difficulty || "medium").toLowerCase()}`;
}

const MAX_TRIES = 3;
const GEN_TIMEOUT_MS_DEFAULT = 8000; // Increased per guide
const TEMP = 0.2;
const TOP_P = 0.9;

// --- Helpers ---
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const truncate = (s, n = 200) => (s && s.length > n ? s.slice(0, n) + "…" : s || "");

function seededPrng(seed) {
  // xorshift32
  let x = (seed >>> 0) || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17; x >>>= 0;
    x ^= x << 5;  x >>>= 0;
    return (x >>> 0) / 0xffffffff;
  };
}

function shuffleWithSeed(arr, seed) {
  const a = arr.slice();
  const rnd = seededPrng(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sanitizeStr(s, fallback = "") {
  return typeof s === "string" && s.trim() ? s.trim() : fallback;
}

function chooseModel(difficulty, env) {
  // Allow overriding via environment variables
  const envEasy   = env?.TRIVIA_MODEL_EASY;
  const envMedium = env?.TRIVIA_MODEL_MEDIUM;
  const envHard   = env?.TRIVIA_MODEL_HARD;

  const DEFAULTS = {
    easy:   "@cf/meta/llama-3.1-8b-instruct",
    medium: "@cf/meta/llama-3.1-70b-instruct",
    hard:   "@cf/meta/llama-3.1-70b-instruct"
  };

  const map = {
    easy:   envEasy   || DEFAULTS.easy,
    medium: envMedium || DEFAULTS.medium,
    hard:   envHard   || DEFAULTS.hard
  };

  const key = (difficulty || "medium").toLowerCase();
  return map[key] || map.medium;
}

function validateQuestion(q) {
  if (!q || typeof q !== "object") return "Empty/invalid object";
  if (typeof q.question !== "string" || !q.question.trim()) return "Missing question";
  if (!Array.isArray(q.choices) || q.choices.length < 2) return "Need at least 2 choices";
  if (!q.choices.every(c => typeof c === "string" && c.trim())) return "All choices must be strings";
  if (!Number.isInteger(q.correct_index)) return "correct_index must be integer";
  if (q.correct_index < 0 || q.correct_index >= q.choices.length) return "correct_index out of bounds";
  if (typeof q.explanation !== "string") return "Missing explanation";
  return null; // valid
}

function coerceAndRandomize(q, seed) {
  const cq = {
    question: sanitizeStr(q.question),
    choices: (Array.isArray(q.choices) ? q.choices.map(c => sanitizeStr(c)) : []).filter(Boolean),
    correct_index: Number.isInteger(q.correct_index) ? q.correct_index : 0,
    explanation: sanitizeStr(q.explanation, ""),
    headword: sanitizeStr(q.headword, ""),
    mode: sanitizeStr(q.mode, "definition"),
    answer_text: sanitizeStr(q.answer_text, ""),
    topic_key: sanitizeStr(q.topic_key, ""),
    subject_matter: sanitizeStr(q.subject_matter, "")
  };

  // Randomize choices deterministically by seed; adjust correct_index
  const originalChoices = cq.choices.slice();
  const correctText = originalChoices[cq.correct_index];
  const shuffled = shuffleWithSeed(originalChoices, seed);
  const newCorrectIndex = shuffled.findIndex(x => x === correctText);

  cq.choices = shuffled;
  cq.correct_index = newCorrectIndex >= 0 ? newCorrectIndex : 0;
  return cq;
}

function safeJsonScan(text) {
  // Try straight parse
  try {
    return JSON.parse(text);
  } catch (_) {}
  // Try to extract first {...} JSON object
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = text.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch (e2) {
      // last-ditch: remove trailing commas
      const cleaned = slice.replace(/,\s*([}\]])/g, "$1");
      try { return JSON.parse(cleaned); } catch (_) {}
    }
  }
  throw new Error("Could not parse JSON from model output");
}

function recentContains(recent, q) {
  // Try matching by question text, fallback to headword
  const key = (q?.question || q?.headword || "").toLowerCase();
  if (!key) return false;
  return recent.some(r => String(r).toLowerCase() === key);
}

function pickFromFallback(category, difficulty, recent, seed) {
  const rnd = seededPrng(seed);
  // Simple filter: if subject/category heuristics match, prefer them.
  const pool = STATIC_PREBUILT.filter(q =>
    !recentContains(recent, q) &&
    (
      (q.subject_matter && String(q.subject_matter).toLowerCase().includes(String(category).toLowerCase())) ||
      (q.topic_key && String(q.topic_key).toLowerCase().includes(String(category).toLowerCase())) ||
      true // always allow
    )
  );
  const selected = pool.length ? pool[Math.floor(rnd() * pool.length)] : STATIC_PREBUILT[Math.floor(rnd() * STATIC_PREBUILT.length)];
  return { ...selected };
}

async function raceWithTimeout(promise, ms) {
  let to;
  const timeout = new Promise((_, reject) => {
    to = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  try {
    const res = await Promise.race([promise, timeout]);
    return res;
  } finally {
    clearTimeout(to);
  }
}

async function generateAndMaybeCache({ category, difficulty, recent, seed }, env, log, timeoutMs) {
  log(`Generation attempt: { category:${category}, difficulty:${difficulty}, hasAI:${!!env.AI} }`);
  if (!env.AI) {
    log("AI binding is missing!");
    return { question: null, error: "AI binding is missing" };
  }

  const MODEL = chooseModel(difficulty, env);
  const sys =
    `Generate a trivia question as JSON only. Format:
{
  "question": "Your question here?",
  "choices": ["A","B","C","D"],
  "correct_index": 0,
  "explanation": "Why this is correct",
  "headword": "answer",
  "mode": "definition",
  "answer_text": "correct answer",
  "topic_key": "topic",
  "subject_matter": "category"
}
Return only valid JSON, no other text.`;

  const user =
    `Category: ${category}. Difficulty: ${difficulty}.
Avoid duplicates of these keys: ${JSON.stringify(recent.slice(-20))}
Respond with strictly valid JSON and exactly one correct_index.`;

  let lastErr = "";
  for (let i = 0; i < MAX_TRIES; i++) {
    try {
      log(`Generation attempt ${i + 1} using model "${MODEL}"`);
      const run = env.AI.run(MODEL, {
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ],
        temperature: TEMP,
        top_p: TOP_P,
        max_tokens: 384,
        seed
      });

      const ai = await raceWithTimeout(run, timeoutMs);
      const text =
        typeof ai === "string"
          ? ai
          : (ai && typeof ai.response === "string" ? ai.response : JSON.stringify(ai));

      log("AI raw (truncated): " + truncate(text, 350));

      const parsed = safeJsonScan(text);
      const err = validateQuestion(parsed);
      if (err) throw new Error("Validation failed: " + err);

      return { question: parsed, error: "" };
    } catch (e) {
      lastErr = (e && e.message) || String(e);
      log(`Generation failed attempt ${i + 1}: ${lastErr}`);
    }
  }

  return { question: null, error: lastErr || "Unknown generation error" };
}

function getOrMakePool(key) {
  if (!HYBRID_POOLS.has(key)) HYBRID_POOLS.set(key, []);
  return HYBRID_POOLS.get(key);
}

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
    if (Array.isArray(body.recent)) recent = body.recent.slice(-100);
    if (Number.isInteger(body.seed)) seed = body.seed;
    if (body.forceGen === true) forceGen = true;
  } catch (_) {}

  // ---------- Model & sampling tuned for accuracy ----------
  const GEN_TIMEOUT_MS = Number(env?.GEN_TIMEOUT_MS) > 0 ? Number(env.GEN_TIMEOUT_MS) : GEN_TIMEOUT_MS_DEFAULT;

  // ---------- Debug headers setup ----------
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  let lastError = "";
  let source = "unknown";
  let retries = 0;
  let modelUsed = chooseModel(difficulty, env);

  // Minimal logger (also shows in Wrangler/dev logs)
  const log = (...args) => console.log("[/api/trivia]", ...args);

  try {
    // ---------- Try in-memory pool unless forceGen ----------
    const key = poolKey(category, difficulty);
    const pool = getOrMakePool(key);

    let picked = null;

    if (!forceGen && pool.length) {
      // Prefer non-duplicate from pool
      for (let i = 0; i < pool.length; i++) {
        if (!recentContains(recent, pool[i])) {
          picked = pool.splice(i, 1)[0];
          source = "hybrid_pool";
          break;
        }
      }
    }

    // ---------- Try AI generation if needed ----------
    if (!picked) {
      const { question, error } = await generateAndMaybeCache(
        { category, difficulty, recent, seed },
        env,
        log,
        GEN_TIMEOUT_MS
      );
      if (question) {
        source = "ai_generation";
        picked = question;
        // Eagerly keep the pool warm
        const valErr = validateQuestion(picked);
        if (!valErr) {
          const poolArr = getOrMakePool(key);
          poolArr.unshift(picked);
          if (poolArr.length > POOL_SIZE) poolArr.length = POOL_SIZE;
        }
      } else {
        lastError = error || "AI generation failed";
        retries = MAX_TRIES;
      }
    }

    // ---------- Fallback if still nothing ----------
    if (!picked) {
      picked = pickFromFallback(category, difficulty, recent, seed);
      source = "fallback_bank";
    }

    // ---------- Normalize & randomize choices (seeded) ----------
    const normalized = coerceAndRandomize(picked, seed);

    // Final validation
    const finalErr = validateQuestion(normalized);
    if (finalErr) {
      lastError = `Post-process validation failed: ${finalErr}`;
      // Force a safe fallback
      const fb = pickFromFallback(category, difficulty, recent, seed + 1);
      const safe = coerceAndRandomize(fb, seed + 1);
      source = source === "ai_generation" ? "fallback_bank_post_validation" : source;
      // headers + return
      headers.set("X-Trivia-Source", source);
      if (lastError) headers.set("X-Trivia-Last-Gen-Error", truncate(lastError));
      headers.set("X-Trivia-Model", modelUsed);
      headers.set("X-Trivia-Retries", String(retries));
      headers.set("X-Trivia-Seed", String(seed));
      headers.set("X-Trivia-Pool", String(getOrMakePool(poolKey(category, difficulty)).length));
      return new Response(JSON.stringify(safe), { status: 200, headers });
    }

    // ---------- Success ----------
    headers.set("X-Trivia-Source", source);
    if (lastError) headers.set("X-Trivia-Last-Gen-Error", truncate(lastError));
    headers.set("X-Trivia-Model", modelUsed);
    headers.set("X-Trivia-Retries", String(retries));
    headers.set("X-Trivia-Seed", String(seed));
    headers.set("X-Trivia-Pool", String(getOrMakePool(poolKey(category, difficulty)).length));

    return new Response(JSON.stringify(normalized), { status: 200, headers });

  } catch (err) {
    lastError = (err && err.message) || String(err);
    console.error("Fatal in /api/trivia:", err);

    const fb = pickFromFallback(category, difficulty, recent, seed + 2);
    const safe = coerceAndRandomize(fb, seed + 2);

    headers.set("X-Trivia-Source", "fatal_fallback");
    headers.set("X-Trivia-Last-Gen-Error", truncate(lastError));
    headers.set("X-Trivia-Model", modelUsed);
    headers.set("X-Trivia-Retries", String(MAX_TRIES));
    headers.set("X-Trivia-Seed", String(seed));
    headers.set("X-Trivia-Pool", String(getOrMakePool(poolKey(category, difficulty)).length));

    return new Response(JSON.stringify(safe), { status: 200, headers });
  }
};
