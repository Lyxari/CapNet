const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { analyzeCapstone } = require('./nlp-engine'); // local scanner, used only if Gemini is unavailable

const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

/**
 * CapNet AI metadata extractor — powered by Google Gemini.
 *
 * Flow:
 *   1. Upload a PDF ➜ extract raw text with pdf-parse
 *   2. Send the first ~12 000 chars to Gemini 2.0 Flash
 *   3. Gemini returns structured JSON: title, authors,
 *      year, abstract
 *   4. Tags are NOT extracted — the student picks them manually
 *      on the dashboard upload form.
 *
 * Environment variable required:
 *   GEMINI_API_KEY — your Google AI Studio API key
 */

const GEMINI_MODEL = 'gemini-3.8-flash';

async function callGemini(pdfText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set. Add it to your environment variables.');
  }

  // Trim to first ~12 000 chars to stay well within Gemini's context window
  // while capturing the cover page, abstract, and early chapters.
  const trimmed = pdfText.slice(0, 12000);

  const systemPrompt = `You are a metadata extractor for academic capstone/thesis papers. Given the raw text extracted from a PDF, return ONLY a valid JSON object with these fields:

{
  "title": "The exact title of the paper",
  "authors": ["Author One Full Name", "Author Two Full Name"],
  "year": 2024,
  "abstract": "The full abstract text from the paper"
}

Rules:
- Extract ONLY information that actually appears in the document text.
- If a field is not found, use "" for strings, [] for arrays, or null for year.
- For authors, return each author's full name as a separate array element.
- For the abstract, return the complete abstract section if present. If there is no explicit "Abstract" section, extract the first substantive paragraph from the Introduction that summarizes the work.
- Return ONLY the JSON — no markdown fences, no commentary, no explanation.`;

  const body = {
    contents: [
      {
        parts: [
          { text: systemPrompt },
          { text: `\n\n--- DOCUMENT TEXT ---\n\n${trimmed}` },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
    },
  };

  // ------------------------------------------------------------------
  // Resilience (added after Render logs showed "503 UNAVAILABLE - high
  // demand" and "HeadersTimeout" from Gemini):
  //   * every attempt has its own timeout, so a stalled Gemini call can
  //     never hang the upload;
  //   * temporary errors (429 / 5xx / timeouts / network) are retried
  //     with a short back-off;
  //   * if the main model keeps failing, backup models are tried;
  //   * the whole thing stays inside a deadline so the dashboard's
  //     60-second wait is never exceeded.
  // ------------------------------------------------------------------
  const baseUrl = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  const attemptTimeoutMs = Number(process.env.GEMINI_ATTEMPT_TIMEOUT_MS) || 15000;
  const deadlineMs = Number(process.env.GEMINI_DEADLINE_MS) || 40000;   // leaves room for the local scan inside the dashboard's 60s wait
  const startedAt = Date.now();

  const models = [GEMINI_MODEL].concat(
    (process.env.GEMINI_FALLBACK_MODELS || 'gemini-2.5-flash,gemini-2.0-flash')
      .split(',').map((m) => m.trim()).filter(Boolean)
  ).filter((m, i, arr) => arr.indexOf(m) === i);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const TEMPORARY = new Set([408, 425, 429, 500, 502, 503, 504]);

  let lastError = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const remaining = deadlineMs - (Date.now() - startedAt);
      if (remaining < 1500) {
        throw lastError || new Error('Gemini did not answer in time.');
      }

      const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(attemptTimeoutMs, remaining));

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!response.ok) {
          const errText = await response.text();
          lastError = new Error(`Gemini API error (${response.status}) on ${model}: ${errText}`);
          lastError.status = response.status;

          if (response.status === 401 || response.status === 403) {
            lastError.fatal = true;      // bad/blocked API key - retrying won't help
            throw lastError;
          }
          if (TEMPORARY.has(response.status)) {
            console.warn(`[gemini] ${model} attempt ${attempt} -> ${response.status}, retrying...`);
            if (attempt < 2) await sleep(800 * attempt);
            continue;               // retry same model, then fall through to the next one
          }
          console.warn(`[gemini] ${model} -> ${response.status}, trying next model`);
          break;                    // e.g. 404 unknown model / 400 -> go straight to the next model
        }

        const json = await response.json();

        // Extract the text from Gemini's response
        const text =
          json?.candidates?.[0]?.content?.parts?.[0]?.text || '';

        if (!text) {
          lastError = new Error('Gemini returned an empty response.');
          if (attempt < 2) await sleep(500);
          continue;
        }

        // Parse the JSON from Gemini — strip markdown fences if present
        const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        try {
          return JSON.parse(cleaned);
        } catch (parseErr) {
          lastError = new Error('Gemini returned malformed JSON.');
          if (attempt < 2) await sleep(500);
          continue;
        }
      } catch (err) {
        clearTimeout(timer);
        if (err && err.fatal) throw err;
        lastError = err.name === 'AbortError'
          ? new Error(`Gemini (${model}) did not respond within ${attemptTimeoutMs / 1000}s.`)
          : err;
        console.warn(`[gemini] ${model} attempt ${attempt} failed: ${lastError.message}`);
        if (attempt < 2) await sleep(800 * attempt);
      }
    }
  }

  throw lastError || new Error('Gemini extraction failed.');
}

// ------------------------------------------------------------------
// Safety net: if Gemini is down or overloaded, scan the PDF with the
// built-in CapNet scanner instead of failing the upload. It reads the
// same four things (title, authors, year, abstract) straight from the
// PDF's cover page and Abstract section - nothing is guessed.
// ------------------------------------------------------------------
function renderPageWithBreaks(pageData) {
  return pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false }).then((tc) => {
    let lastY = null;
    let text = '';
    for (const item of tc.items) {
      if (lastY === item.transform[5] || lastY === null) text += item.str;
      else text += '\n' + item.str;
      lastY = item.transform[5];
    }
    return text + '\n\f\n';
  });
}

async function localExtract(buffer) {
  const parsed = await pdfParse(buffer, { max: 30, pagerender: renderPageWithBreaks });
  const r = analyzeCapstone(parsed.text);
  return { title: r.title, authors: r.authors, year: r.year, abstract: r.abstract };
}

router.post('/process-capstone', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No PDF file uploaded.' });
    }

    const pdfData = await pdfParse(req.file.buffer);
    const rawText = pdfData.text;

    if (!rawText || !rawText.trim()) {
      return res.status(400).json({
        success: false,
        error: 'The uploaded PDF contains no readable text.',
      });
    }

    let result;
    let source = 'gemini-ai';
    try {
      result = await callGemini(rawText);
    } catch (geminiErr) {
      console.error('Gemini extraction error:', geminiErr);
      if (geminiErr && geminiErr.fatal) {
        console.error('Check GEMINI_API_KEY on Render - Gemini rejected the key.');
      }
      // Don't fail the student's upload - scan the PDF locally instead.
      result = await localExtract(req.file.buffer);
      source = 'local-scan';
    }

    // Normalize the Gemini response into the format the frontend expects
    return res.status(200).json({
      success: true,
      data: {
        title: result.title || '',
        authors: Array.isArray(result.authors) ? result.authors.join('; ') : (result.authors || ''),
        adviser: '',
        program: '',
        year: Number.isFinite(Number(result.year)) && Number(result.year) > 0 ? Number(result.year) : null,
        abstract: result.abstract || '',
        abstractSource: source,
        tags: [],           // Tags are now manually selected by the student
      },
    });
  } catch (err) {
    console.error('Gemini extraction error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;