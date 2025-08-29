export const onRequestPost = async (context) => {
  const { request, env } = context;

  // ---------- Read input ----------
  let category = "general";
  let difficulty = "medium";
  let recent = [];
  let seed = Math.floor(Math.random() * 1e9);
  let fetching = false; // prevents overlapping fetches

  try {
    const body = await request.json();
    if (typeof body.category === "string") category = body.category;
    if (typeof body.difficulty === "string") difficulty = body.difficulty;
    if (Array.isArray(body.recent)) recent = body.recent.slice(-100); // Increased from 50 to 100
    if (Number.isInteger(body.seed)) seed = body.seed;
  } catch (_) {}

  // ---------- Model & sampling tuned for accuracy ----------
  const MODEL_MAP = {
    easy:   "@cf/meta/llama-3.1-8b-instruct",       // Better accuracy than fast version
    medium: "@cf/meta/llama-3.1-70b-instruct",      // Upgrade to 70b for better quality
    hard:   "@cf/meta/llama-3.1-70b-instruct"       // Keep 70b for consistency
  };
  const MODEL = MODEL_MAP[difficulty] || MODEL_MAP.medium;

  // Reduced temperature for more consistent, accurate responses
  const TEMP  = (difficulty === "hard") ? 0.70 : 0.75;
  const TOP_P = (difficulty === "hard") ? 0.85 : 0.88;

  // More retries for better deduplication
  const MAX_TRIES = 8;

  // ---------- JSON schema with stricter validation ----------
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      question: { type: "string", minLength: 10, maxLength: 140 },
      choices: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
      correct_index: { type: "integer", minimum: 0, maximum: 3 },
      explanation: { type: "string", maxLength: 200 },
      headword: { type: "string" },
      mode: { type: "string", enum: ["definition", "synonym"] },
      answer_text: { type: "string" },
      topic_key: { type: "string" },
      subject_matter: { type: "string" } // New field for better dedup
    },
    required: ["question", "choices", "correct_index", "answer_text", "topic_key", "subject_matter"]
  };

  // ---------- Enhanced prompt steering ----------
  const difficultyHint =
    difficulty === "easy"   ? "Create simple, straightforward questions about widely known facts. Avoid ambiguity." :
    difficulty === "hard"   ? "Create challenging but fair questions. No tricks or obscure trivia. Focus on deeper knowledge." :
                              "Create balanced questions suitable for general knowledge enthusiasts.";

  const categoryHint = (() => {
    switch (category) {
      case "dictionary":
        return [
          "This is a VOCABULARY question about one headword.",
          "Return headword (the word), mode ('definition' or 'synonym'), and subject_matter (the word itself).",
          "If mode is 'definition': stem MUST be 'What is the best definition of \"<headword>\"?'",
          "If mode is 'synonym': stem MUST be 'Which word is the closest synonym of \"<headword>\"?'",
          "Choices must be mutually exclusive and clearly different.",
          "For 'synonym' they are single words; for 'definition' they are short, clear definition phrases.",
          "Ensure the correct answer is unambiguously correct."
        ].join(" ");
      case "science_nature": 
        return "Ask about biology, chemistry, physics, astronomy, or nature. Focus on interesting facts. Include subject_matter field.";
      case "entertainment":  
        return "Ask about movies, TV shows, music, books, or games. Avoid recent releases or spoilers. Include subject_matter field.";
      case "food_drink":     
        return "Ask about cuisines, dishes, ingredients, cooking techniques, or beverages. Include subject_matter field.";
      case "geography":      
        return "Ask about countries, capitals, landmarks, rivers, mountains, or regions. Include subject_matter field.";
      case "history":        
        return "Ask about historical events, figures, civilizations, or time periods. Include subject_matter field.";
      default:               
        return "General knowledge from any domain. Focus on interesting, verifiable facts. Include subject_matter field.";
    }
  })();

  // Enhanced deduplication check
  const recentTopics = recent.map(q => {
    // Extract the core subject from questions
    const normalized = (q || "").toLowerCase().trim();
    // Try to extract the main subject (words in quotes, proper nouns, etc.)
    const quoted = normalized.match(/"([^"]+)"/);
    if (quoted) return quoted[1];
    // For other questions, use key phrases
    return normalized.replace(/^(what|which|who|when|where|how|why)\s+/i, "").slice(0, 50);
  }).filter(Boolean);

  const avoidBlock = recentTopics.length
    ? "These topics were recently asked - create something COMPLETELY DIFFERENT:\n- " +
      recentTopics.slice(-20).join("\n- ")
    : "Create fresh, unique questions.";

  const messages = [
    {
      role: "system",
      content: [
        "You are an expert trivia question generator.",
        "Create accurate, unambiguous multiple-choice questions.",
        "Return valid JSON matching the schema exactly.",
        "Questions must be factually correct and verifiable.",
        "The correct answer must be definitively correct.",
        "Wrong answers must be plausible but clearly incorrect.",
        "Never repeat topics or subjects from the avoid list.",
        "Include a 'subject_matter' field with the core topic/subject of the question."
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
        "Requirements:",
        "1. Create ONE original question with exactly four choices",
        "2. Set correct_index (0-3) to the index of the correct answer",
        "3. Set answer_text to EXACTLY match the text of the correct choice",
        "4. Set topic_key to EXACTLY match answer_text",
        "5. Set subject_matter to the core topic/subject (e.g., 'George Washington', 'photosynthesis', 'Paris')",
        "6. Add a brief, interesting explanation (one sentence)",
        "7. For dictionary category: include headword and mode fields",
        "8. Ensure factual accuracy - no outdated or disputed information",
        "9. Make wrong answers clearly distinguishable from the correct one"
      ].join("\n")
    }
  ];

  const jsonHeaders = { "content-type": "application/json", "cache-control": "no-store" };

  // ---------- Per-client short lock to avoid overlapping requests ----------
  // Prevents rapid double-clicks from the same client producing parallel generations.
  if (!globalThis.__REQ_LOCKS) globalThis.__REQ_LOCKS = new Map();
  const ip = request.headers.get("cf-connecting-ip") || "anon";
  const lockKey = `${ip}:${category}:${difficulty}`;
  const now = Date.now();
  const until = globalThis.__REQ_LOCKS.get(lockKey) || 0;
  if (now < until) {
    return new Response(
      JSON.stringify({ error: "too_many_requests", retry_after_ms: until - now }),
      { headers: jsonHeaders, status: 429 }
    );
  }
  // Set a short lock window (2.5s) — expires automatically
  globalThis.__REQ_LOCKS.set(lockKey, now + 2500);

  // ---------- Fallback questions pool ----------
  const fallbacks = [
    {
      question: "Which planet is known as the 'Red Planet'?",
      choices: ["Venus", "Jupiter", "Mars", "Saturn"],
      correct_index: 2,
      explanation: "Mars appears red due to iron oxide on its surface."
    },
    {
      question: "What is the smallest country in the world?",
      choices: ["Monaco", "Vatican City", "San Marino", "Liechtenstein"],
      correct_index: 1,
      explanation: "Vatican City covers just 0.17 square miles."
    },
    {
      question: "Which element has the chemical symbol 'Au'?",
      choices: ["Silver", "Aluminum", "Gold", "Argon"],
      correct_index: 2,
      explanation: "Au comes from the Latin word 'aurum' meaning gold."
    }
  ];

  const fallback = () => {
    const fb = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    return {
      id: crypto.randomUUID(),
      ...fb,
      source: "fallback"
    };
  };

  if (!env?.AI?.run) {
    return new Response(JSON.stringify(fallback()), { headers: jsonHeaders });
  }

  // ---------- Helper functions ----------
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
  const looksPhrase = (s) => /\s/.test(s || "") && (s || "").length > 3;

  const firstSentence = (s) => {
    const str = String(s || "").trim();
    const m = str.match(/^[^.!?]*[.!?]/);
    return m ? m[0].trim() : str.slice(0, 100).trim();
  };

  // Enhanced question similarity check
  const isSimilarQuestion = (q1, q2) => {
    const n1 = normalize(q1);
    const n2 = normalize(q2);
    
    // Exact match
    if (n1 === n2) return true;
    
    // Check if they share significant substring (>60% overlap)
    const minLen = Math.min(n1.length, n2.length);
    if (minLen > 20) {
      const checkLen = Math.floor(minLen * 0.6);
      if (n1.includes(n2.slice(0, checkLen)) || n2.includes(n1.slice(0, checkLen))) {
        return true;
      }
    }
    
    // Check if core subject matches (words in quotes, main nouns)
    const extract = (s) => {
      const quoted = s.match(/"([^"]+)"/g);
      if (quoted) return quoted.map(q => q.replace(/"/g, ""));
      // Extract likely subject (capitalized words, key terms)
      const words = s.split(/\s+/);
      return words.filter(w => w.length > 4);
    };
    
    const subjects1 = extract(q1);
    const subjects2 = extract(q2);
    
    for (const s1 of subjects1) {
      for (const s2 of subjects2) {
        if (s1 === s2 && s1.length > 5) return true;
      }
    }
    
    return false;
  };

  const kvEnabled = !!env.TRIVIA_KV;

  // Persistent dedup storage across requests
  if (!globalThis.__TRIVIA_SEEN) {
    globalThis.__TRIVIA_SEEN = new Map(); // category:difficulty -> Set of topic hashes
  }
  if (!globalThis.__TRIVIA_LAST) {
    globalThis.__TRIVIA_LAST = new Map(); // category:difficulty -> last topic
  }

  const memoryKey = `${category}:${difficulty}`;
  if (!globalThis.__TRIVIA_SEEN.has(memoryKey)) {
    globalThis.__TRIVIA_SEEN.set(memoryKey, new Set());
  }
  const seenSet = globalThis.__TRIVIA_SEEN.get(memoryKey);

  // ---------- Generate with comprehensive validation ----------
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    try {
      const aiRes = await env.AI.run(MODEL, {
        messages,
        response_format: { type: "json_schema", json_schema: schema },
        temperature: TEMP,
        top_p: TOP_P,
        seed: seed + attempt * 997 // Prime number for variation
      });

      const payload = aiRes?.response ?? aiRes;

      // ---- Core validation ----
      const qText = norm(payload?.question);
      const choices = Array.isArray(payload?.choices) ? payload.choices.map(norm) : [];
      const answerText = norm(payload?.answer_text);
      const topicKey = norm(payload?.topic_key);
      const subjectMatter = norm(payload?.subject_matter || topicKey);
      const correctIndex = payload?.correct_index;

      // Validate structure
      const uniqueChoices = new Set(choices.map(c => c.toLowerCase()));
      const idxFromAnswer = choices.findIndex(c => c.toLowerCase() === answerText.toLowerCase());

      if (
        !qText ||
        qText.length < 10 ||
        choices.length !== 4 ||
        uniqueChoices.size !== 4 ||
        idxFromAnswer === -1 ||
        idxFromAnswer !== correctIndex ||
        !answerText ||
        !topicKey ||
        topicKey.toLowerCase() !== answerText.toLowerCase()
      ) {
        if (attempt < MAX_TRIES - 1) continue;
        throw new Error("Validation failed: structure issues");
      }

      // ---- Dictionary category validation ----
      if (category === "dictionary") {
        const head = norm(payload?.headword);
        const mode = String(payload?.mode || "").toLowerCase();
        
        if (!head || !["definition", "synonym"].includes(mode)) {
          if (attempt < MAX_TRIES - 1) continue;
          throw new Error("Dictionary validation failed");
        }
        
        const qLower = qText.toLowerCase();
        if (!qLower.includes(head.toLowerCase())) {
          if (attempt < MAX_TRIES - 1) continue;
        }
        
        if (mode === "synonym") {
          if (!choices.every(c => looksSingleWord(c))) {
            if (attempt < MAX_TRIES - 1) continue;
          }
          if (answerText.toLowerCase() === head.toLowerCase()) {
            if (attempt < MAX_TRIES - 1) continue;
          }
        } else {
          if (!choices.every(c => looksPhrase(c))) {
            if (attempt < MAX_TRIES - 1) continue;
          }
        }
      }

      // ---- Enhanced deduplication checks ----
      
      // 1. Check against recent questions (fuzzy match)
      const isDupe = recent.some(r => isSimilarQuestion(qText, r));
      if (isDupe && attempt < MAX_TRIES - 1) {
        continue;
      }

      // 2. Check subject matter hash (global dedup)
      const subjectHash = await sha256(`${category}:${subjectMatter.toLowerCase()}`);
      
      // KV store check
      if (kvEnabled) {
        const kvKey = `q:${category}:${subjectHash}`;
        const seen = await env.TRIVIA_KV.get(kvKey);
        if (seen && attempt < MAX_TRIES - 1) {
          continue;
        }
      }
      
      // Memory check
      if (seenSet.has(subjectHash) && attempt < MAX_TRIES - 1) {
        continue;
      }

      // 3. Check answer/topic dedup
      const topicHash = await sha256(`${category}:${normalize(topicKey)}`);
      
      if (kvEnabled) {
        const topicKvKey = `topic:${category}:${topicHash}`;
        const topicSeen = await env.TRIVIA_KV.get(topicKvKey);
        if (topicSeen && attempt < MAX_TRIES - 1) {
          continue;
        }
      }

      // 4. Back-to-back prevention
      const lastKey = `last:${memoryKey}`;
      const lastSubject = globalThis.__TRIVIA_LAST.get(memoryKey);
      
      if (lastSubject && normalize(lastSubject) === normalize(subjectMatter) && attempt < MAX_TRIES - 1) {
        continue;
      }

      // ---- Store for deduplication ----
      
      // KV storage (persistent)
      if (kvEnabled) {
        // Store by subject
        await env.TRIVIA_KV.put(`q:${category}:${subjectHash}`, "1", { 
          expirationTtl: 60 * 60 * 24 * 60 // 60 days
        });
        
        // Store by topic/answer
        await env.TRIVIA_KV.put(`topic:${category}:${topicHash}`, "1", { 
          expirationTtl: 60 * 60 * 24 * 60 // 60 days
        });
        
        // Store last subject
        await env.TRIVIA_KV.put(`last:${category}:${difficulty}`, subjectMatter, { 
          expirationTtl: 60 * 15 // 15 minutes
        });
      }
      
      // Memory storage (runtime)
      seenSet.add(subjectHash);
      if (seenSet.size > 1000) {
        // Trim oldest entries if set gets too large
        const arr = Array.from(seenSet);
        seenSet.clear();
        arr.slice(-500).forEach(h => seenSet.add(h));
      }
      globalThis.__TRIVIA_LAST.set(memoryKey, subjectMatter);

      // ---- Success - return the question ----
      const result = {
        id: crypto.randomUUID(),
        question: qText,
        choices,
        correct_index: correctIndex,
        explanation: firstSentence(payload.explanation || ""),
        _debug: {
          validated: true,
          attempt,
          model: MODEL,
          temp: TEMP,
          top_p: TOP_P,
          subject: subjectMatter.slice(0, 30),
          dedup_checks: {
            recent_count: recent.length,
            memory_seen: seenSet.size,
            kv_enabled: kvEnabled
          }
        }
      };
      
      return new Response(JSON.stringify(result), { headers: jsonHeaders });

    } catch (err) {
      // On last attempt, use fallback
      if (attempt === MAX_TRIES - 1) {
        const fb = fallback();
        fb._debug = { 
          error: "max_attempts_reached",
          message: err.message,
          attempt,
          model: MODEL
        };
        return new Response(JSON.stringify(fb), { headers: jsonHeaders });
      }
      // Otherwise try again with different seed
      seed = seed + 12347;
    }
  }

  // Final fallback
  const fb = fallback();
  fb._debug = { error: "exhausted_all_attempts", model: MODEL };
  return new Response(JSON.stringify(fb), { headers: jsonHeaders });
};
