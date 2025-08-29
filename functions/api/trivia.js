export const onRequestPost = async (context) => {
  const { request, env } = context;

  // ---- Read input ----
  let category = "general";
  let recent = [];
  let seed = Math.floor(Math.random() * 1e9);
  let difficulty = "medium";

  try {
    const body = await request.json();
    if (typeof body.category === "string") category = body.category;
    if (Array.isArray(body.recent)) recent = body.recent.slice(-25);
    if (Number.isInteger(body.seed)) seed = body.seed;
    if (typeof body.difficulty === "string") difficulty = body.difficulty;
  } catch (_) {}

  const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

  // ---- JSON schema ----
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      question: { type: "string" },
      choices: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
      correct_index: { type: "integer", minimum: 0, maximum: 3 },
      explanation: { type: "string" }
    },
    required: ["question", "choices", "correct_index"]
  };

  // ---- Prompt steering ----
  const difficultyHint = (() => {
    switch (difficulty) {
      case "easy":   return "Keep it beginner-friendly and widely known.";
      case "hard":   return "Increase difficulty moderately; no obscurities or trick wording.";
      default:       return "Keep difficulty balanced for a general audience.";
    }
  })();

  // Stronger guidance for dictionary
  const dictionaryRules = [
    "Pick a real English headword (CEFR A2–C1).",
    "Ask EITHER for the best definition OR the closest synonym.",
    "Choices must be words or short definitions, mutually exclusive.",
    "Avoid generic knowledge questions; this is about vocabulary only.",
  ].join(" ");

  const avoidBlock = recent.length
    ? "Avoid repeating any of these exact questions:\n- " +
      recent.map(q => (q||"").toString().trim()).filter(Boolean).join("\n- ")
    : "Vary subtopics and avoid overused or generic questions.";

  const categoryHint = (() => {
    switch (category) {
      case "dictionary": return dictionaryRules;
      case "science_nature": return "Prefer high-school level science; no trick questions.";
      case "entertainment": return "Use film, TV, music, books, or games; avoid spoilers.";
      case "food_drink": return "Use cuisines, ingredients, techniques, or beverages.";
      case "geography": return "Use countries, capitals, landmarks, or physical geography.";
      case "history": return "Prefer well-known events, eras, or figures.";
      default: return "General knowledge suitable for a broad audience.";
    }
  })();

  const messages = [
    {
      role: "system",
      content: [
        "You generate concise, unambiguous multiple-choice trivia questions.",
        "Return JSON conforming to the schema exactly.",
        "Keep the question <= 140 characters.",
        "Choices must be plausible and mutually exclusive.",
        "Avoid offensive/adult topics."
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
        "Create exactly one question with four choices and correct_index (0-3).",
        "Add one-sentence explanation or fun fact."
      ].join("\n")
    }
  ];

  const jsonHeaders = { "content-type": "application/json", "cache-control": "no-store" };

  // ---- Local fallback ----
  const fallback = () => ({
    id: crypto.randomUUID(),
    question: "Which planet is known as the Red Planet?",
    choices: ["Venus", "Mars", "Jupiter", "Mercury"],
    correct_index: 1,
    explanation: "Mars looks red due to iron oxide on its surface.",
    source: "fallback"
  });

  if (!env?.AI?.run) {
    return new Response(JSON.stringify(fallback()), { headers: jsonHeaders });
  }

  // ---- Helpers ----
  const sha256 = async (text) => {
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  };

  // ---- Generate with global de-dup via KV ----
  const MAX_TRIES = 5;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    let kvHit = false, kvPut = false, kvKey = undefined;

    try {
      const aiRes = await env.AI.run(MODEL, {
        messages,
        response_format: { type: "json_schema", json_schema: schema },
        // nudge diversity
        temperature: 0.9,
        top_p: 0.9,
        seed: seed + attempt
      });

      const payload = aiRes?.response ?? aiRes;
      const qText = (payload?.question || "").trim();
      if (!qText) throw new Error("Empty question");

      // Global de-dup: hash on normalized question text
      const h = await sha256(qText.toLowerCase());
      kvKey = `q:${category}:${h}`;
      const seen = env.TRIVIA_KV ? await env.TRIVIA_KV.get(kvKey) : null;

      if (seen) {
        kvHit = true;
        if (attempt < MAX_TRIES - 1) continue; // try again with new seed
      } else if (env.TRIVIA_KV) {
        await env.TRIVIA_KV.put(kvKey, "1", { expirationTtl: 60 * 60 * 24 * 7 }); // 7 days
        kvPut = true;
      }

      const out = {
        id: crypto.randomUUID(),
        question: qText,
        choices: payload.choices,
        correct_index: payload.correct_index,
        explanation: payload.explanation || "",
        _debug: { attempt, kvHit, kvPut } // lightweight debug to verify KV
      };

      return new Response(JSON.stringify(out), { headers: jsonHeaders });
    } catch (err) {
      if (attempt === MAX_TRIES - 1) {
        const f = fallback();
        f._debug = { attempt, kvHit: false, kvPut: false, error: "fallback" };
        return new Response(JSON.stringify(f), { headers: jsonHeaders });
      }
    }
  }

  // Safety net
  const f = fallback();
  f._debug = { attempt: MAX_TRIES, error: "exhausted" };
  return new Response(JSON.stringify(f), { headers: jsonHeaders });
};
