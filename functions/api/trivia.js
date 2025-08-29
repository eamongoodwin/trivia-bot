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
    easy:   "@cf/meta/llama-3.1-8b-instruct",
    medium: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    hard:   "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b"
  };
  const MODEL = MODEL_MAP[difficulty] || MODEL_MAP.medium;

  // Reduced temperature for more consistent, accurate responses
  const TEMP  = (difficulty === "hard") ? 0.60 : 0.65;
  const TOP_P = (difficulty === "hard") ? 0.88 : 0.9;

  // More retries for better deduplication
  const MAX_TRIES = 3;

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
    question: "What is the largest ocean on Earth?",
    choices: ["Atlantic Ocean", "Indian Ocean", "Pacific Ocean", "Arctic Ocean"],
    correct_index: 2,
    explanation: "The Pacific Ocean is the largest and deepest of Earth's ocean basins."
  },
  {
    question: "What is the capital city of Japan?",
    choices: ["Kyoto", "Osaka", "Tokyo", "Nagoya"],
    correct_index: 2,
    explanation: "Tokyo has been Japan's capital since 1869."
  },
  {
    question: "What is the hardest natural substance?",
    choices: ["Quartz", "Diamond", "Gold", "Graphite"],
    correct_index: 1,
    explanation: "Diamond's strong carbon lattice makes it the hardest natural material."
  },
  {
    question: "Which animal is the tallest on land?",
    choices: ["Elephant", "Giraffe", "Horse", "Camel"],
    correct_index: 1,
    explanation: "Adult giraffes can exceed 5.5 meters (18 feet) in height."
  },
  {
    question: "H2O is the chemical formula for what substance?",
    choices: ["Hydrogen", "Water", "Oxygen", "Salt"],
    correct_index: 1,
    explanation: "H2O represents water, composed of two hydrogen atoms and one oxygen."
  },
  {
    question: "Plants make their own food using which process?",
    choices: ["Fermentation", "Respiration", "Photosynthesis", "Germination"],
    correct_index: 2,
    explanation: "Photosynthesis converts light energy into chemical energy in plants."
  },
  {
    question: "Who wrote the play 'Romeo and Juliet'?",
    choices: ["Charles Dickens", "Leo Tolstoy", "William Shakespeare", "Mark Twain"],
    correct_index: 2,
    explanation: "Shakespeare wrote the tragedy in the late 16th century."
  },
  {
    question: "How many continents are there on Earth?",
    choices: ["Five", "Six", "Seven", "Eight"],
    correct_index: 2,
    explanation: "The widely taught model counts seven continents."
  },
  {
    question: "Which gas makes up most of Earth's atmosphere?",
    choices: ["Oxygen", "Nitrogen", "Carbon dioxide", "Argon"],
    correct_index: 1,
    explanation: "Nitrogen is about 78% of the atmosphere by volume."
  },
  {
    question: "Which is the fastest land animal?",
    choices: ["Lion", "Cheetah", "Pronghorn", "Horse"],
    correct_index: 1,
    explanation: "Cheetahs can sprint up to about 100–120 km/h in short bursts."
  },
  {
    question: "Which is the largest planet in our Solar System?",
    choices: ["Earth", "Saturn", "Jupiter", "Neptune"],
    correct_index: 2,
    explanation: "Jupiter is the biggest, with a mass over 300 times Earth's."
  },
  {
    question: "What is the currency of the United Kingdom?",
    choices: ["Euro", "Pound sterling", "US Dollar", "Krona"],
    correct_index: 1,
    explanation: "The British currency is the pound sterling (GBP)."
  },
  {
    question: "Which organ pumps blood through the body?",
    choices: ["Lungs", "Kidneys", "Heart", "Liver"],
    correct_index: 2,
    explanation: "The heart circulates blood via rhythmic contractions."
  },
  {
    question: "Which common metal is strongly attracted to magnets?",
    choices: ["Copper", "Iron", "Aluminum", "Gold"],
    correct_index: 1,
    explanation: "Iron is ferromagnetic and is strongly attracted to magnets."
  },
  {
    question: "What is the square root of 81?",
    choices: ["7", "8", "9", "10"],
    correct_index: 2,
    explanation: "9 × 9 equals 81."
  },
  {
    question: "Which is the longest river in Africa?",
    choices: ["Niger", "Nile", "Congo", "Zambezi"],
    correct_index: 1,
    explanation: "The Nile flows over 6,600 km through northeastern Africa."
  },
  {
    question: "What is the chemical symbol for sodium?",
    choices: ["So", "S", "Na", "Sd"],
    correct_index: 2,
    explanation: "Na comes from the Latin name 'natrium' for sodium."
  },
  {
    question: "Which country is home to the Great Barrier Reef?",
    choices: ["New Zealand", "Australia", "Fiji", "Indonesia"],
    correct_index: 1,
    explanation: "The Great Barrier Reef lies off Australia's northeast coast."
  },
  {
    question: "Who painted the 'Mona Lisa'?",
    choices: ["Michelangelo", "Raphael", "Leonardo da Vinci", "Vincent van Gogh"],
    correct_index: 2,
    explanation: "Leonardo painted it in the early 16th century."
  },
  {
    question: "What is the first element on the periodic table?",
    choices: ["Helium", "Hydrogen", "Lithium", "Carbon"],
    correct_index: 1,
    explanation: "Hydrogen has atomic number 1."
  },
  {
    question: "Which language has the most native speakers?",
    choices: ["English", "Spanish", "Mandarin Chinese", "Hindi"],
    correct_index: 2,
    explanation: "Mandarin Chinese has the largest number of native speakers."
  },
  {
    question: "Which is the largest hot desert on Earth?",
    choices: ["Gobi", "Kalahari", "Sahara", "Arabian"],
    correct_index: 2,
    explanation: "The Sahara is the largest hot desert by area."
  },
  {
    question: "How many degrees are in a right angle?",
    choices: ["45", "60", "90", "180"],
    correct_index: 2,
    explanation: "A right angle measures exactly 90 degrees."
  },
  {
    question: "Which instrument has keys, pedals, and strings?",
    choices: ["Harp", "Violin", "Piano", "Trumpet"],
    correct_index: 2,
    explanation: "A piano uses hammers to strike strings when keys are pressed."
  },
  {
    question: "What is the closest star to Earth?",
    choices: ["Alpha Centauri", "Sirius", "Betelgeuse", "The Sun"],
    correct_index: 3,
    explanation: "Our Sun is the nearest star to Earth."
  },
  {
    question: "What protein in red blood cells carries oxygen?",
    choices: ["Myoglobin", "Hemoglobin", "Albumin", "Collagen"],
    correct_index: 1,
    explanation: "Hemoglobin binds oxygen for transport in the bloodstream."
  },
  {
    question: "Which country is nicknamed the 'Land of the Rising Sun'?",
    choices: ["China", "Japan", "Thailand", "South Korea"],
    correct_index: 1,
    explanation: "Japan's name is linked to the eastern sunrise."
  },
  {
    question: "Which planet has the most prominent rings?",
    choices: ["Venus", "Mars", "Saturn", "Mercury"],
    correct_index: 2,
    explanation: "Saturn's ring system is the most extensive and visible."
  },
  {
    question: "What is the largest land carnivore?",
    choices: ["Tiger", "Grizzly bear", "Polar bear", "Wolf"],
    correct_index: 2,
    explanation: "Adult male polar bears are the largest land carnivores."
  },
  {
    question: "What instrument is used to measure temperature?",
    choices: ["Thermometer", "Barometer", "Altimeter", "Hygrometer"],
    correct_index: 0,
    explanation: "A thermometer measures temperature."
  },
  {
    question: "Which cell organelle is known as the powerhouse of the cell?",
    choices: ["Nucleus", "Mitochondria", "Ribosome", "Golgi apparatus"],
    correct_index: 1,
    explanation: "Mitochondria generate most of the cell's ATP."
  },
  {
    question: "What is the official language of Brazil?",
    choices: ["Spanish", "Portuguese", "French", "Italian"],
    correct_index: 1,
    explanation: "Brazil's official and most spoken language is Portuguese."
  },
  {
    question: "How many sides does a hexagon have?",
    choices: ["Five", "Six", "Seven", "Eight"],
    correct_index: 1,
    explanation: "A hexagon is a six-sided polygon."
  },
  {
    question: "In which city is the Colosseum located?",
    choices: ["Athens", "Rome", "Istanbul", "Barcelona"],
    correct_index: 1,
    explanation: "The Colosseum is an ancient amphitheater in Rome, Italy."
  },
  {
    question: "How many players are on the field for one soccer team?",
    choices: ["9", "10", "11", "12"],
    correct_index: 2,
    explanation: "Association football has 11 players per team on the field."
  },
  {
    question: "What is the chemical formula for table salt?",
    choices: ["Na2CO3", "NaCl", "KCl", "HCl"],
    correct_index: 1,
    explanation: "Common table salt is sodium chloride, NaCl."
  },
  {
    question: "Which is the largest continent by area?",
    choices: ["Africa", "Europe", "Asia", "North America"],
    correct_index: 2,
    explanation: "Asia is the largest continent."
  },
  {
    question: "Which vitamin is produced in the skin when exposed to sunlight?",
    choices: ["Vitamin A", "Vitamin B12", "Vitamin C", "Vitamin D"],
    correct_index: 3,
    explanation: "UV light helps the skin synthesize vitamin D."
  },
  {
    question: "What do bees primarily collect to make honey?",
    choices: ["Nectar", "Pollen", "Sap", "Dew"],
    correct_index: 0,
    explanation: "Bees convert flower nectar into honey."
  },
  {
    question: "Cairo is the capital of which country?",
    choices: ["Morocco", "Egypt", "Tunisia", "Sudan"],
    correct_index: 1,
    explanation: "Cairo is the capital and largest city of Egypt."
  },
  {
    question: "Which instrument measures atmospheric pressure?",
    choices: ["Anemometer", "Barometer", "Hygrometer", "Thermometer"],
    correct_index: 1,
    explanation: "A barometer measures air pressure."
  },
  {
    question: "Who proposed the theory of relativity?",
    choices: ["Isaac Newton", "Galileo Galilei", "Marie Curie", "Albert Einstein"],
    correct_index: 3,
    explanation: "Einstein introduced special (1905) and general (1915) relativity."
  },
  {
    question: "Which metal is liquid at room temperature?",
    choices: ["Mercury", "Aluminum", "Sodium", "Nickel"],
    correct_index: 0,
    explanation: "Mercury is a liquid metal at standard conditions."
  },
  {
    question: "Which country gifted the Statue of Liberty to the United States?",
    choices: ["France", "Spain", "Italy", "Germany"],
    correct_index: 0,
    explanation: "France presented the statue in 1886 as a symbol of friendship."
  },
  {
    question: "What is the name of our galaxy?",
    choices: ["Andromeda", "Sombrero", "Milky Way", "Triangulum"],
    correct_index: 2,
    explanation: "Earth is located in the Milky Way galaxy."
  },
  {
    question: "Which organ primarily detoxifies chemicals in the body?",
    choices: ["Stomach", "Liver", "Pancreas", "Spleen"],
    correct_index: 1,
    explanation: "The liver metabolizes and detoxifies many substances."
  },
  {
    question: "At sea level, what is the boiling point of water in Celsius?",
    choices: ["90°C", "95°C", "100°C", "110°C"],
    correct_index: 2,
    explanation: "Water boils at 100°C at standard atmospheric pressure."
  },
  {
    question: "On which continent is the Amazon Rainforest located?",
    choices: ["Africa", "Asia", "South America", "Australia"],
    correct_index: 2,
    explanation: "Most of the Amazon lies within South America, chiefly Brazil."
  },
  {
    question: "What is the largest bone in the human body?",
    choices: ["Tibia", "Femur", "Humerus", "Radius"],
    correct_index: 1,
    explanation: "The femur (thighbone) is the body's longest and strongest bone."
  },
  {
    question: "Which instrument typically has six strings in standard tuning?",
    choices: ["Violin", "Cello", "Guitar", "Flute"],
    correct_index: 2,
    explanation: "A standard guitar has six strings tuned E–A–D–G–B–E."
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
