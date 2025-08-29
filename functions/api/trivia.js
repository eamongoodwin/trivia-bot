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

  const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

  // ---------- JSON schema (requires answer_text) ----------
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      question: { type: "string" },
      choices: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
      correct_index: { type: "integer", minimum: 0, maximum: 3 },
      explanation: { type: "string" },
      topic_key: { type: "string" },
      headword: { type: "string" },     // dictionary only
      mode: { type: "string" },         // 'definition' | 'synonym' (dictionary)
      answer_text: { type: "string" }   // EXACT text of the correct choice
    },
    required: ["question", "choices", "correct_index", "answer_text"]
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
          "Return fields headword (the word) and mode ('definition' or 'synonym').",
          "If mode is 'definition': the stem MUST be exactly like: What is the best definition of \"<headword>\"?",
          "If mode is 'synonym': the stem MUST be exactly like: Which word is the closest synonym of \"<headword>\"?",
          "Choices must be mutually exclusive.",
          "For 'synonym' they should be single words; for 'definition' they should be short definition phrases.",
          "Do NOT write general-knowledge stems (e.g., 'A person who...')."
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
        "Return JSON that exactly matches the schema.",
        "Keep the question <= 140 characters.",
        "Provide four plausible, mutually exclusive choices.",
        "Avoid vague stems like 'often', 'commonly', 'usually', or 'popular'.",
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
        "Add one-sentence explanation or fun fact.",
        "Return an 'answer_text' field that EXACTLY equals the correct choice string.",
        "Ensure the other three choices do not satisfy all facts in the question.",
        "Also include a 'topic_key' naming the main subject (e.g., 'Amazon River', 'Pythagoras', 'photosynthesis').",
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
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const norm = (s) => String(s || "").trim();

  const looksSingleWord = (s) => /^[A-Za-z-]+$/.test(s || "");
  const looksPhrase     = (s) => /\s/.test(s || ""); // has at least one space

  // ---------- Generate with validation + global de-dup ----------
  const MAX_TRIES = 8;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    let kvHit = false, kvPut = false;

    try {
      const aiRes = await env.AI.run(MODEL, {
        messages,
        response_format: { type: "json_schema", json_schema: schema },
        temperature: 0.95,
        top_p: 0.95,
        seed: seed + attempt * 1337
      });

      const payload = aiRes?.response ?? aiRes;

      // ---- Validate core structure ----
      const qText = norm(payload?.question);
      const choices = Array.isArray(payload?.choices) ? payload.choices.map(norm) : [];
      const answerText = norm(payload?.answer_text);
      const correctIndex = payload?.correct_index;

      const uniqueCount = new Set(choices.map(c => c.toLowerCase())).size;
      const idxFromAnswer = choices.findIndex(c => c.toLowerCase() === answerText.toLowerCase());

      if (!qText || choices.length !== 4 || uniqueCount !== 4 || idxFromAnswer === -1 || idxFromAnswer !== correctIndex) {
        throw new Error("Validation failed: answer/choices mismatch or duplicates");
      }

      // ---- Extra validation for dictionary category ----
      if (category === "dictionary") {
        const head = norm(payload?.headword);
        const mode = String(payload?.mode || "").toLowerCase();

        if (!head || !["definition", "synonym"].includes(mode)) {
          throw new Error("Validation failed: dictionary requires headword and mode");
        }

        const qLower = qText.toLowerCase();
        const headLower = head.toLowerCase();

        // Stem must include headword and mode keyword
        if (!qLower.includes(headLower)) throw new Error("Validation failed: dictionary stem missing headword");
        if (mode === "definition" && !qLower.includes("definition")) throw new Error("Validation failed: stem must contain 'definition'");
        if (mode === "synonym" && !qLower.includes("synonym")) throw new Error("Validation failed: stem must contain 'synonym'");

        // Choice shape rules
        if (mode === "synonym") {
          if (choices.some(c => !looksSingleWord(c))) throw new Error("Validation failed: synonym choices must be single words");
          if (answerText.toLowerCase() === headLower) throw new Error("Validation failed: synonym answer cannot equal headword");
        } else {
          if (choices.some(c => !looksPhrase(c))) throw new Error("Validation failed: definition choices should look like short phrases");
          if (choices.some(c => c.toLowerCase() === headLower)) throw new Error("Validation failed: definition choices cannot be the headword");
        }
      }

      // ---- Subject key for de-dup (dictionary uses headword when possible) ----
      let subject =
        category === "dictionary"
          ? (payload.headword || payload.topic_key || qText)
          : (payload.topic_key || qText);

      const normalizedQ = normalize(qText);
      const normalizedSubject = normalize(subject);

      // Fuzzy recent guard from client
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
        await env.TRIVIA_KV.put(kvKey, "1", { expirationTtl: 60 * 60 * 24 * 30 });
        kvPut = true;
      }

      // Good to return
      const out = {
        id: crypto.randomUUID(),
        question: qText,
        choices,
        correct_index: correctIndex,
        explanation: norm(payload.explanation),
        _debug: {
          validated: true,
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
      // otherwise loop and try again with new seed
    }
  }

  // Safety net
  const f = fallback();
  f._debug = { attempt: MAX_TRIES, error: "exhausted" };
  return new Response(JSON.stringify(f), { headers: jsonHeaders });
};
