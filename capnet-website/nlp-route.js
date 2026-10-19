const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { analyzeCapstone, chooseTitle } = require('./nlp-engine'); // local scanner, used only if Gemini is unavailable

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
  const trimmed = pdfText.slice(0, 12000).replace(/\f/g, '\n\n[PAGE BREAK]\n\n');

  // The cover page on its own, so the model can tell the title apart from header lines.
  const pages = pdfText.split('\f');
  const cover = (pages[0].trim().length < 150 && pages[1] ? pages[0] + '\n' + pages[1] : pages[0]).slice(0, 3000);

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
- The "title" is the title of the STUDY itself. It is NOT the degree program (e.g. "BACHELOR OF ARTS IN ..."), NOT the document type (e.g. "Capstone/Special Project", "Thesis"), NOT the name of the university, college, or faculty, and it must not contain page numbers. On a cover page the title usually sits between those header lines and the "by" / "Submitted by" line. Keep the title's original wording and join lines that were wrapped.
- "authors" are ONLY the students/researchers who wrote the study (listed after "by" / "Submitted by" on the cover page) — NOT the adviser, panel members, dean, or faculty. Write each name without titles (Dr., Engr.) or credentials (PhD, MBA), and not in ALL CAPS.
- A COVER PAGE section is provided first; use it for the title, authors, and year.
- Return ONLY the JSON — no markdown fences, no commentary, no explanation.`;

  const body = {
    contents: [
      {
        parts: [
          { text: systemPrompt },
          { text: `\n\n--- COVER PAGE ---\n\n${cover}` },
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

function localExtract(text) {
  const r = analyzeCapstone(text);
  return { title: r.title, authors: r.authors, year: r.year, abstract: r.abstract, abstractFound: r.abstractFound };
}

// ------------------------------------------------------------------
// Author names: drop titles/credentials/footnote marks, un-shout ALL CAPS,
// remove duplicates and anything that is clearly not a person.
// (The dashboard then turns them into APA style, e.g. "Lariosa, D. E. T.")
// ------------------------------------------------------------------
function normalizeAuthors(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/;|\n/);
  const seen = new Set();
  const out = [];
  for (let name of list) {
    name = String(name || '')
      .replace(/[*\u2020\u2021\u00B9\u00B2\u00B3]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(?:Dr|Engr|Prof|Mr|Ms|Mrs|Atty)\.?\s+/i, '')
      .replace(/,?\s*(?:Ph\.?D\.?|MBA|MAMS|MSc|MIT|MIS|DIT|RN|LPT|CPA|PECE)\.?$/i, '')
      .replace(/\d+$/, '')
      .trim();
    if (name.length < 3 || /\b(?:adviser|advisor|panel|dean|university|college)\b/i.test(name)) continue;
    name = name.split(' ').map((w) => (w.length > 2 && w === w.toUpperCase()
      ? w.charAt(0) + w.slice(1).toLowerCase() : w)).join(' ');
    const key = name.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(name); }
  }
  return out;
}

router.post('/process-capstone', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No PDF file uploaded.' });
    }

    // Page breaks (form-feed) are added so the cover page and Abstract section can be told apart.
    const pdfData = await pdfParse(req.file.buffer, { pagerender: renderPageWithBreaks });
    const rawText = pdfData.text;

    if (!rawText || !rawText.trim()) {
      return res.status(400).json({
        success: false,
        error: 'The uploaded PDF contains no readable text.',
      });
    }

    // Built-in scan of the cover page + Abstract section (first 30 pages). Used to double-check
    // Gemini, and as the fallback if Gemini is unavailable.
    let local = null;
    try {
      local = localExtract(rawText.split('\f').slice(0, 30).join('\f\n'));
    } catch (scanErr) {
      console.warn('Local scan failed:', scanErr.message);
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
      // Don't fail the student's upload - use the built-in scan instead.
      if (!local) throw geminiErr;
      result = local;
      source = 'local-scan';
    }

    // Title: make sure it is the title of the STUDY, not the cover's program / university lines.
    const title = chooseTitle(result.title, local && local.title);

    // Authors: cleaned; if Gemini found none, use what the cover page scan found.
    let authors = normalizeAuthors(result.authors);
    if (!authors.length && local) authors = normalizeAuthors(local.authors);

    // Year: Gemini's, or the cover page's if Gemini gave none.
    const yearNum = Number(result.year);
    const year = Number.isFinite(yearNum) && yearNum > 0 ? yearNum : (local && local.year) || null;

    // Abstract: if the PDF has a real Abstract section, copy it word-for-word (Gemini may shorten it).
    let abstract = result.abstract || '';
    if (local && local.abstractFound) {
      abstract = local.abstract;
      if (source === 'gemini-ai') source = 'pdf-abstract-section';
    }

    // Normalize the response into the format the frontend expects
    return res.status(200).json({
      success: true,
      data: {
        title,
        authors: authors.join('; '),
        year,
        abstract,
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