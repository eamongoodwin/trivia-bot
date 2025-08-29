export const onRequestPost = async (context) => {
  const { request, env } = context;

  // Read input
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

  // JSON schema yes
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

  const difficultyHint = (() => {
    switch (difficulty) {
      case "easy":
        return "Make it beginner-friendly and widely known; avoid niche facts.";
      case "hard":
        return "Increase difficulty moderately (no obscurities), require careful thought.";
      default:
        return "Keep difficulty balanced for a general audience.";
    }
  })();

  const avoidBlock = recent.length
    ? "Avoid repeating any of these exact questions:\n- " + recent.map(q => (q||"").toString().trim()).filter(Boolean).join("\n- ")
    : "Ensure the question varies subtopics and is not overused.";

  const messages = [
    {
      role: "system",
      content: [
        "You generate concise, unambiguous multiple-choice trivia questions.",
        "Return JSON that matches the provided schema exactly.",
        "Keep the question <= 140 characters.",
        "Choices must be plausible and mutually exclusive.",
        "Avoid offensive/adult topics."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        `Category: ${category}`,
        difficultyHint,
        avoidBlock,
        "Create exactly one question with four choices and correct_index (0-3).",
        "For 'dictionary', ask for a real English word definition or synonym (A1–C1).",
        "For 'science_nature', prefer HS-level science (no trick wording).",
        "For 'entertainment', include film/TV/music/books/games; avoid spoilers.",
        "For 'food_drink', use cuisines, ingredients, techniques, or beverages.",
        "For 'geography', use countries, capitals, landmarks, or physical geography.",
        "For 'history', prefer well-known events/figures.",
        "Add a one-sentence explanation or fun fact."
      ].join("\n")
    }
  ];

  const jsonHeaders = { "content-type": "application/json", "cache-control": "no-store" };

  // Local fallback
  const fallback = () => ({
    id: crypto.randomUUID(),
    question: "What is the capital of Japan?",
    choices: ["Kyoto", "Osaka", "Tokyo", "Nagoya"],
    correct_index: 2,
    explanation: "Tokyo has been Japan’s capital since 1868 (Meiji Restoration).",
    source: "fallback"
  });

  if (!env?.AI?.run) {
    return new Response(JSON.stringify(fallback()), { headers: jsonHeaders });
  }

  // Simple SHA-256 helper
  const sha256 = async (text) => {
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  };

  // Generate with a few retries if KV says we've seen it recently
  const MAX_TRIES = 3;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    try {
      const aiRes = await env.AI.run(MODEL, {
        messages,
        response_format: { type: "json_schema", json_schema: schema },
        temperature: 0.8,
        top_p: 0.9,
        seed: seed + attempt // nudge variation
      });

      const payload = aiRes?.response ?? aiRes;
      const qText = (payload?.question || "").trim();
      if (!qText) throw new Error("Empty question");

      // GLOBAL DE-DUP with KV
      const h = await sha256(qText.toLowerCase());
      const k = `q:${h}`;
      const seen = env.TRIVIA_KV ? await env.TRIVIA_KV.get(k) : null;

      if (seen) {
        // Try again with a different seed
        if (attempt < MAX_TRIES - 1) continue;
      } else if (env.TRIVIA_KV) {
        // Store for 7 days
        await env.TRIVIA_KV.put(k, "1", { expirationTtl: 60 * 60 * 24 * 7 });
      }

      const out = {
        id: crypto.randomUUID(),
        question: qText,
        choices: payload.choices,
        correct_index: payload.correct_index,
        explanation: payload.explanation || ""
      };

      return new Response(JSON.stringify(out), { headers: jsonHeaders });
    } catch (err) {
      // On error, fall through to next attempt
      if (attempt === MAX_TRIES - 1) {
        return new Response(JSON.stringify(fallback()), { headers: jsonHeaders });
      }
    }
  }

  // Safety net
  return new Response(JSON.stringify(fallback()), { headers: jsonHeaders });
};
