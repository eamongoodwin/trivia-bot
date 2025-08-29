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
    if (Array.isArray(body.recent)) recent = body.recent.slice(-50); // larger recent window
    if (Number.isInteger(body.seed)) seed = body.seed;
  } catch (_) {}

  const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

  // ---------- JSON schema (adds optional topic_key/headword/mode) ----------
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      question: { type: "string" },
      choices: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
      correct_index: { type: "integer", minimum: 0, maximum: 3 },
      explanation: { type: "string" },
      topic_key: { type: "string" },          // e.g., "Amazon River", "Pythagoras"
      headword: { type: "string" },           // dictionary only, e.g., "succinct"
      mode: { type: "string" }                // dictionary: "definition" or "synonym"
    },
    required: ["question", "choices", "correct_index"]
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
          "Pick a real English headword (CEFR A2–C1).",
          "Ask EITHER for the best definition OR the closest synonym.",
          "Return fields headword (the word) and mode ('definition' or 'synonym').",
          "Choices must be short words or short definitions; mutually exclusive.",
          "Do not ask general trivia like foods or colors; this is vocabulary."
        ].join(" ");
      case "science_nature": return "Prefer high-school level science; avoid trick questions.";
      case "entertainment":  return "Use film, TV, music, books, or games; avoid spoilers.";
      case "food_drink":     return "Use cuisines, ingredients, techniques, or beverages.";
      case "geography":      return "Use countries, capitals, landmarks, or physical geography.";
      case "history":        return "Prefer well-known events or figures.";
      default:               return "General knowledge suitable for a broad audience.";
    }
  })();

  const avoidBlock = recent.length
    ? "Avoid repeating any of these exact questions:\n- " +
      recent.map(q => (q||"").toString().trim()).filter(Boolean).join("\n- ")
    : "Vary subtopics and avoid overused questions.";

  const messages = [
    {
      role: "system",
      content: [
        "You generate concise, unambiguous multiple-choice trivia.",
        "Return JSON that exactly matches the provided schema.",
        "Keep the question <= 140 characters.",
        "Provide four plausible, mutually exclusive choices.",
        "Avoid offensive/adult content."
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
        "Include a one-sentence explanation or fun fact.",
        "Also include a 'topic_key' that names the main subject (e.g., 'Amazon River', 'Pythagoras', 'photosynthesis').",
        "For dictionary, also include 'headword' and 'mode'."
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
      .replace(/[^\w\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  // ---------- Generate with stronger global de-dup ----------
  const MAX_TRIES = 8; // more chances to avoid repeats
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    let kvHit = false, kvPut = false;

    try {
      const aiRes = await env.AI.run(MODEL, {
        messages,
        response_format: { type: "json_schema", json_schema: schema },
        temperature: 0.95, // more diversity
        top_p: 0.95,
        seed: seed + attempt * 1337
      });

      const payload = aiRes?.response ?? aiRes;
      const qText = (payload?.question || "").trim();
      if (!qText) throw new Error("Empty question");

      // Build a stable "subject" key:
      // - dictionary: prefer headword
      // - otherwise: prefer topic_key, else normalized question text
      let subject =
        category === "dictionary"
          ? (payload.headword || payload.topic_key || qText)
          : (payload.topic_key || qText);

      const normalizedQ = normalize(qText);
      const normalizedSubject = normalize(subject);

      // Extra client-provided recent guard (fuzzy)
      const isRecentDupe = recent.some(r => {
        const n = normalize(r);
        return n === normalizedQ ||
               (n.length > 24 && (normalizedQ.includes(n.slice(0,24)) || n.includes(normalizedQ.slice(0,24))));
      });
      if (isRecentDupe && attempt < MAX_TRIES - 1) continue;

      // KV global de-dup (30 days)
      const h = await sha256(`${category}:${difficulty}:${normalizedSubject}`);
      const kvKey = `q:${category}:${h}`;
      const seen = env.TRIVIA_KV ? await env.TRIVIA_KV.get(kvKey) : null;

      if (seen) {
        kvHit = true;
        if (attempt < MAX_TRIES - 1) continue;
      } else if (env.TRIVIA_KV) {
        await env.TRIVIA_KV.put(kvKey, "1", { expirationTtl: 60 * 60 * 24 * 30 }); // 30 days
        kvPut = true;
      }

      const out = {
        id: crypto.randomUUID(),
        question: qText,
        choices: payload.choices,
        correct_index: payload.correct_index,
        explanation: payload.explanation || "",
        _debug: {
          attempt, kvHit, kvPut,
          subject: normalizedSubject.slice(0,64),
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
    }
  }

  // Safety net
  const f = fallback();
  f._debug = { attempt: MAX_TRIES, error: "exhausted" };
  return new Response(JSON.stringify(f), { headers: jsonHeaders });
};
