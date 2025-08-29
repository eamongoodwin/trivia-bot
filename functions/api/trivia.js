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
    if (Array.isArray(body.recent)) recent = body.recent.slice(-50);
    if (Number.isInteger(body.seed)) seed = body.seed;
  } catch (_) {}

  const MODEL_MAP = {
    easy:   "@cf/meta/llama-3.1-8b-instruct-fast",
    medium: "@cf/meta/llama-3.1-8b-instruct",      // higher quality than -fast
    hard:   "@cf/meta/llama-3.1-70b-instruct"      // larger model for tough items
  };
  const MODEL = MODEL_MAP[difficulty] || MODEL_MAP.medium;

  // ---------- JSON schema ----------
  // Require answer_text AND topic_key (the canonical subject == correct answer).
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      question: { type: "string" },
      choices: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
      correct_index: { type: "integer", minimum: 0, maximum: 3 },
      explanation: { type: "string" },
      // dictionary extras (kept for stronger checks)
      headword: { type: "string" },
      mode: { type: "string" }, // 'definition' | 'synonym'
      // NEW required fields:
      answer_text: { type: "string" },
      topic_key: { type: "string" } // MUST equal answer_text exactly
    },
    required: ["question", "choices", "correct_index", "answer_text", "topic_key"]
  };

  // ---------- Prompt steering ----------
  const difficultyHint =
    difficulty === "easy"   ? "Keep it beginner-friendly and widely known." :
    difficulty === "hard"   ? "Increase difficulty moderately; no trick wording or obscure minutiae." :
                              "Keep difficulty balanced for a general audience.";

  const categoryHint = (() => {
    switch (category) {
      case "dictionary":
        return [
          "This is a VOCABULARY question about one headword.",
          "Return headword (the word) and mode ('definition' or 'synonym').",
          "If mode is 'definition': stem MUST be 'What is the best definition of \"<headword>\"?'",
          "If mode is 'synonym': stem MUST be 'Which word is the closest synonym of \"<headword>\"?'",
          "Choices must be mutually exclusive.",
          "For 'synonym' they are single words; for 'definition' they are short definition phrases.",
          "Do NOT write general-knowledge stems (e.g., 'A person who ...')."
        ].join(" ");
      case "science_nature": return "Prefer high-school level science; avoid trick questions.";
      case "entertainment":  return "Use film, TV, music, books, or games; avoid spoilers.";
      case "food_drink":     return "Ask about specific dishes, ingredients, techniques, or beverages.";
      case "geography":      return "Ask about countries, capitals, landmarks, or physical geography.";
      case "history":        return "Prefer well-known events or figures.";
      default:               return "General knowledge suitable for a broad audience.";
    }
  })();

  const avoidBlock = recent.length
    ? "Avoid repeating any of these exact questions:\n- " +
      recent.map(q => (q||"").toString().trim()).filter(Boolean).join("\n- ")
    : "Vary subtopics and avoid overused questions.";

  // IMPORTANT: tell the model to set topic_key to the correct answer exactly.
  const messages = [
    {
      role: "system",
      content: [
        "You generate concise, unambiguous multiple-choice trivia.",
        "Return JSON that exactly matches the schema.",
        "Keep the question <= 140 characters.",
        "Provide four plausible, mutually exclusive choices.",
        "Avoid vague stems like 'often', 'commonly', 'usually', or 'popular'.",
        "Avoid offensive/adult content.",
        "Set 'answer_text' to the exact correct choice string.",
        "Set 'topic_key' EXACTLY to the same string as 'answer_text'."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        `Category: ${category}`,
        `Difficulty: ${difficulty}`,
        difficultyHint,
        categoryHint,
        avoidBlock,
        "Create exactly ONE question with four choices and correct_index (0-3).",
        "Add one-sentence explanation or fun fact.",
        "Return 'answer_text' that EXACTLY equals the correct choice.",
        "Return 'topic_key' that EXACTLY equals the correct choice.",
        "Also include 'headword' and 'mode' for the dictionary category."
      ].join("\n")
    }
  ];

  const jsonHeaders = { "content-type": "application/json", "cache-control": "no-store" };

  // ---------- Fallback ----------
  const fallback = () => ({
    id: crypto.randomUUID(),
    question: "Which ocean borders California?",
    choices: ["Atlantic", "Arctic", "Indian", "Pacific"],
    correct_index: 3,
    explanation: "California lies on the Pacific coast.",
    source: "fallback"
  });

  if (!env?.AI?.run) {
    return new Response(JSON.stringify(fallback()), { headers: jsonHeaders });
  }

  // ---------- Helpers ----------
  const sha256 = async (text) => {
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  };

  const normalize = (s) =>
    (s || "")
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const norm = (s) => String(s || "").trim();

  const looksSingleWord = (s) => /^[A-Za-z-]+$/.test(s || "");
  const looksPhrase     = (s) => /\s/.test(s || "");

  // ---------- Generate with validation + global de-dup ----------
  const MAX_TRIES = 8;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    let kvHit = false, kvPut = false;

    try {
      const temp = (difficulty === "hard") ? 0.8 : 0.9;
      const aiRes = await env.AI.run(MODEL, {
        messages,
        response_format: { type: "json_schema", json_schema: schema },
        temperature: temp,
        top_p: 0.95,
        seed: seed + attempt * 1337
      });

      const payload = aiRes?.response ?? aiRes;

      // ---- Core validation (answer_text + topic_key) ----
      const qText = norm(payload?.question);
      const choices = Array.isArray(payload?.choices) ? payload.choices.map(norm) : [];
      const answerText = norm(payload?.answer_text);
      const topicKey = norm(payload?.topic_key);
      const correctIndex = payload?.correct_index;

      const uniqueCount = new Set(choices.map(c => c.toLowerCase())).size;
      const idxFromAnswer = choices.findIndex(c => c.toLowerCase() === answerText.toLowerCase());

      if (
        !qText ||
        choices.length !== 4 ||
        uniqueCount !== 4 ||
        idxFromAnswer === -1 ||
        idxFromAnswer !== correctIndex ||
        answerText.length === 0 ||
        topicKey.length === 0 ||
        topicKey.toLowerCase() !== answerText.toLowerCase()
      ) {
        throw new Error("Validation failed: answer/choices mismatch or topic_key mismatch");
      }

      // ---- Extra rules for dictionary ----
      if (category === "dictionary") {
        const head = norm(payload?.headword);
        const mode = String(payload?.mode || "").toLowerCase();
        if (!head || !["definition", "synonym"].includes(mode)) {
          throw new Error("Validation failed: dictionary requires headword and mode");
        }
        const qLower = qText.toLowerCase();
        if (!qLower.includes(head.toLowerCase())) throw new Error("Dictionary stem must include headword");
        if (mode === "definition" && !qLower.includes("definition")) throw new Error("Stem must contain 'definition'");
        if (mode === "synonym" && !qLower.includes("synonym")) throw new Error("Stem must contain 'synonym'");
        if (mode === "synonym") {
          if (choices.some(c => !looksSingleWord(c))) throw new Error("Synonym choices must be single words");
          if (answerText.toLowerCase() === head.toLowerCase()) throw new Error("Synonym answer cannot equal headword");
        } else {
          if (choices.some(c => !looksPhrase(c))) throw new Error("Definition choices should be short phrases");
          if (choices.some(c => c.toLowerCase() === head.toLowerCase())) throw new Error("Definition choices cannot be the headword");
        }
      }

      // ---- Recent fuzzy guard (tightened) ----
      const normalizedQ = normalize(qText);
      const isRecentDupe = recent.some(r => {
        const n = normalize(r);
        // identical OR substantial overlap (>=16 chars)
        return n === normalizedQ ||
               (n.length > 16 && (normalizedQ.includes(n.slice(0,16)) || n.includes(normalizedQ.slice(0,16))));
      });
      if (isRecentDupe && attempt < MAX_TRIES - 1) continue;

      // ---- KV global de-dup by topic_key (== correct answer) ----
      const keySubject = normalize(topicKey); // canonical dedup target
      const h = await sha256(`${category}:${difficulty}:${keySubject}`);
      const kvKey = `q:${category}:${h}`;
      const seen = env.TRIVIA_KV ? await env.TRIVIA_KV.get(kvKey) : null;

      if (seen) {
        kvHit = true;
        if (attempt < MAX_TRIES - 1) continue;
      } else if (env.TRIVIA_KV) {
        await env.TRIVIA_KV.put(kvKey, "1", { expirationTtl: 60 * 60 * 24 * 30 }); // 30 days
        kvPut = true;
      }

      // ---- Success ----
      const out = {
        id: crypto.randomUUID(),
        question: qText,
        choices,
        correct_index: correctIndex,
        explanation: norm(payload.explanation),
        _debug: {
          validated: true,
          attempt, kvHit, kvPut,
          dedup_by: keySubject.slice(0,64),
          mode: payload.mode || null,
          headword: payload.headword || null
        }
      };
      return new Response(JSON.stringify(out), { headers: jsonHeaders });

    } catch (err) {
      if (attempt === MAX_TRIES - 1) {
        const f = fallback();
        f._debug = { attempt, error: "fallback" };
        return new Response(JSON.stringify(f), { headers: jsonHeaders });
      }
      // otherwise try a new seed
    }
  }

  // Safety net
  const f = fallback();
  f._debug = { attempt: MAX_TRIES, error: "exhausted" };
  return new Response(JSON.stringify(f), { headers: jsonHeaders });
};
