const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfParse = require('pdf-parse');

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

const GEMINI_MODEL = 'gemini-2.0-flash';

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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

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

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errText}`);
  }

  const json = await response.json();

  // Extract the text from Gemini's response
  const text =
    json?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  if (!text) {
    throw new Error('Gemini returned an empty response.');
  }

  // Parse the JSON from Gemini — strip markdown fences if present
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(cleaned);
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

    const result = await callGemini(rawText);

    // Normalize the Gemini response into the format the frontend expects
    return res.status(200).json({
      success: true,
      data: {
        title: result.title || '',
        authors: Array.isArray(result.authors) ? result.authors.join('; ') : (result.authors || ''),
        adviser: '',
        program: '',
        year: result.year || null,
        abstract: result.abstract || '',
        abstractSource: 'gemini-ai',
        tags: [],           // Tags are now manually selected by the student
      },
    });
  } catch (err) {
    console.error('Gemini extraction error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;