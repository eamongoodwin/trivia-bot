# QuizGrid — Cloudflare Pages + Workers AI Trivia

A sleek, NYT‑inspired web trivia game. The UI runs on **Cloudflare Pages** with **Pages Functions**, and the questions are generated in real‑time via **Workers AI** (Llama 3.1 8B fast) using JSON Mode for strict structured output.

## One‑click structure

```
/ (Pages static)
  index.html
  styles.css
/functions
  /api/trivia.js   ← Pages Function that calls Workers AI
```

## Deploy (Pages)

1. **Create a new Pages project** (Git or Direct Upload).  
2. In **Pages → Settings → Functions → Compatibility date**, set a recent date (e.g. today).  
3. In **Pages → Settings → Functions → Bindings → Workers AI**, add a binding named **`AI`** (this exposes `context.env.AI`).  
4. Deploy.

> If you prefer Wrangler: `npx wrangler pages deploy .`

## Local dev (optional)

```bash
npm i -g wrangler
wrangler pages dev .
```

## How it works

- The front‑end (index.html) fetches `POST /api/trivia` with `{ category }`.
- The Function (`functions/api/trivia.js`) calls Workers AI with model `@cf/meta/llama-3.1-8b-instruct-fast` and enables **JSON Mode** with a schema that enforces:
  - `question` (string), `choices` (array of 4), `correct_index` (0–3), `explanation` (string).
- If the AI binding is missing or JSON Mode fails, a safe **fallback** question is returned.

## Customize

- Add difficulties, timers, or leaderboards (KV/D1) as needed.
- Swap models (e.g., `@cf/meta/llama-3-8b-instruct` or `@cf/meta/llama-3.1-70b-instruct`) in `functions/api/trivia.js`.
- To experiment safely, front-load instructions in `messages[1].content` of the Function.

## Notes

- Categories supported: `general`, `dictionary`, `entertainment`, `history`, `food_drink`, `geography`, `science_nature`.
- Keyboard shortcuts: `1–4` to answer, `Enter` for next.
- Client stores score & streak in `localStorage` only.

## Credits

- Built for Cloudflare Pages + Workers AI.  
- Styling inspired by crossword‑clean NYT vibes, but fonts remain system‑safe.
