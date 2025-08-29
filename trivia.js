export const onRequestPost = async (context) => {
  const { request, env } = context;
  let category = "general";
  try {
    const body = await request.json();
    if (body && typeof body.category === "string") category = body.category;
  } catch (_) {}

  // Prefer a fast model for low latency
  const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

  // JSON Mode schema to force structure
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      question: { type: "string" },
      choices: {
        type: "array",
        items: { type: "string" },
        minItems: 4,
        maxItems: 4
      },
      correct_index: { type: "integer", minimum: 0, maximum: 3 },
      explanation: { type: "string" }
    },
    required: ["question", "choices", "correct_index"]
  };

  const messages = [
    {
      role: "system",
      content: [
        "You generate concise, unambiguous multiple-choice trivia questions.",
        "Output must follow the provided JSON schema.",
        "Keep the question <= 140 characters.",
        "Choices must be plausible and mutually exclusive.",
        "Avoid offensive or adult topics. Prefer mainstream, globally known facts."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        "Category: " + category,
        "Make 1 question with exactly four choices and the correct_index (0-3).",
        "For 'dictionary', ask for a real English word (A1–C1 level) definition or synonym.",
        "For 'science_nature', avoid trick questions. Prefer HS-level science.",
        "For 'entertainment', include film, TV, music, books, or games; avoid spoilers.",
        "For 'food_drink', include cuisines, ingredients, techniques, or beverages.",
        "For 'geography', include countries, capitals, landmarks, or physical geography.",
        "For 'history', avoid niche local trivia; prefer well-known events/figures.",
        "Add a one-sentence explanation/fun fact."
      ].join("\n")
    }
  ];

  // If the AI binding isn't configured, return a static fallback question
  const fallback = () => {
    const samples = {
      general: {
        question: "Which gas do humans need to breathe to survive?",
        choices: ["Nitrogen", "Oxygen", "Carbon dioxide", "Helium"],
        correct_index: 1,
        explanation: "Air is ~21% oxygen, which our cells use to make energy."
      },
      dictionary: {
        question: "What is the best synonym for 'succinct'?",
        choices: ["Wordy", "Vague", "Brief", "Confusing"],
        correct_index: 2,
        explanation: "'Succinct' means expressed clearly in few words."
      },
      entertainment: {
        question: "Who directed the film 'Jurassic Park' (1993)?",
        choices: ["James Cameron", "Steven Spielberg", "Ridley Scott", "Peter Jackson"],
        correct_index: 1,
        explanation: "Spielberg's blockbuster set new standards for CGI and animatronics."
      },
      history: {
        question: "The Magna Carta was signed in which year?",
        choices: ["1066", "1215", "1492", "1776"],
        correct_index: 1,
        explanation: "Signed in 1215, it limited the English king’s power."
      },
      food_drink: {
        question: "What gives traditional pesto its green color?",
        choices: ["Parsley", "Basil", "Spinach", "Cilantro"],
        correct_index: 1,
        explanation: "Classic Genovese pesto uses fresh basil leaves."
      },
      geography: {
        question: "Which river flows through Cairo?",
        choices: ["Tigris", "Danube", "Nile", "Euphrates"],
        correct_index: 2,
        explanation: "Cairo sits on the banks of the Nile in Egypt."
      },
      science_nature: {
        question: "What is the chemical symbol for sodium?",
        choices: ["S", "Na", "So", "Sn"],
        correct_index: 1,
        explanation: "From Latin 'natrium', hence the symbol Na."
      }
    };
    const d = samples[category] || samples.general;
    return { id: crypto.randomUUID(), ...d, source: "fallback" };
  };

  if (!env || !env.AI || !env.AI.run) {
    return new Response(JSON.stringify(fallback()), {
      headers: { "content-type": "application/json" }
    });
  }

  try {
    const aiRes = await env.AI.run(MODEL, {
      messages,
      // JSON Mode to enforce a strict object
      response_format: {
        type: "json_schema",
        json_schema: schema
      }
    });

    // aiRes may be { response: {...} } or already the object
    const payload = aiRes?.response ?? aiRes;

    const out = {
      id: crypto.randomUUID(),
      question: payload.question,
      choices: payload.choices,
      correct_index: payload.correct_index,
      explanation: payload.explanation || ""
    };

    return new Response(JSON.stringify(out), {
      headers: { "content-type": "application/json" }
    });
  } catch (err) {
    // Fall back gracefully if JSON Mode fails or rate-limited
    return new Response(JSON.stringify(fallback()), {
      headers: { "content-type": "application/json" },
      status: 200
    });
  }
};
