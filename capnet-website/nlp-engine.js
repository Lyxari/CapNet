/* ============================================================
   CapNet NLP engine  (runs on Render AND in the browser)

   Scans ONLY four things from the front matter of a capstone PDF:
     1. Title
     2. Authors
     3. Year
     4. Abstract  — copied word-for-word from the document's real
                    "Abstract" section, however long it is (there is
                    NO word or character limit). Nothing is summarized
                    or guessed. If the PDF has no Abstract section,
                    `abstract` is empty and `abstractFound` is false.

   Input: text of the first pages of the PDF, one visual line per line,
   with a form-feed ("\f") between pages when available.
   ============================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CapNetNLP = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PAGE = "\u0000PAGE";            // internal page-break marker line
  const ROMAN = /^[ivxlcdm]{1,6}$/i;

  /* ---------------- clean-up ---------------- */

  function cleanLines(rawText) {
    const out = [];
    String(rawText || "")
      .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, " ")
      .replace(/\r/g, "")
      .split("\n")
      .forEach((raw) => {
        const hasFormFeed = raw.indexOf("\f") !== -1;
        const l = raw.replace(/\f/g, "").replace(/\s+/g, " ").trim();
        if (l) {
          const isPageNo = /^\d{1,3}$/.test(l) || (ROMAN.test(l) && l.length <= 6 && !/^(?:i|a)$/i.test(l));
          const isTocLeader = /\.{4,}/.test(l);
          if (!isPageNo && !isTocLeader) out.push(l);
        }
        if (hasFormFeed && out[out.length - 1] !== PAGE) out.push(PAGE);
      });
    return out;
  }

  const real = (arr) => arr.filter((l) => l !== PAGE);

  /* ---------------- ABSTRACT (verbatim, unlimited length) ---------------- */

  // "Abstract" / "ABSTRACT" / "A B S T R A C T" / "1. Abstract" / "Abstract:" / "Abstract — text…"
  const ABSTRACT_HEAD = /^(?:\d+(?:\.\d+)*\.?\s*)?a\s?b\s?s\s?t\s?r\s?a\s?c\s?t\s*(?:[:.\-–—]\s*|\s*$)(.*)$/i;

  // Headings that always end an abstract.
  const HARD_STOP = /^(?:\d+(?:\.\d+)*\.?\s*)?(?:key\s?-?words?|index terms|table of contents|contents|acknowledg(?:e)?ments?|dedication|list of (?:tables|figures|abbreviations|appendices)|declaration|approval sheet|certification|abstrak|resumen|chapter\s+(?:\d+|[ivx]+|one)\b)/i;

  // Headings that end an abstract only when they stand alone on a line
  // (so a structured abstract with "Background: …" / "Introduction: …" keeps going).
  const SOFT_STOP = /^(?:\d+(?:\.\d+)*\.?\s*)?(?:introduction|background(?: of the study)?|statement of the problem|review of related literature|rationale)\s*:?$/i;

  const isShoutingHeading = (l) =>
    l.length >= 4 && l.length <= 60 && /^[A-Z0-9 &/:,'\-]+$/.test(l) && /[A-Z]{4}/.test(l);

  function joinWrapped(lines) {
    let out = "";
    for (const l of lines) {
      if (!out) { out = l; continue; }
      if (/[a-z]-$/.test(out) && /^[a-z]/.test(l)) out = out.slice(0, -1) + l;   // "docu-" + "ment"
      else out += " " + l;
    }
    return out.replace(/\s+([.,;:!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
  }

  function findAbstract(lines) {
    const candidates = [];

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(ABSTRACT_HEAD);
      if (!m) continue;

      const inline = (m[1] || "").trim();
      // Table-of-contents entry like "Abstract iii" / "Abstract 4"
      if (inline && (/^\d{1,3}$/.test(inline) || ROMAN.test(inline))) continue;

      const parts = inline ? [inline] : [];
      let pagesCrossed = 0;

      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];

        if (l === PAGE) {
          // Keep going across a page break only if the text stops mid-sentence.
          const soFar = parts.join(" ");
          if (!soFar || /[.!?"”')\]]\s*$/.test(soFar) || pagesCrossed >= 3) break;
          pagesCrossed++;
          continue;
        }

        const wordCount = l.split(/\s+/).length;
        const standalone = wordCount <= 6 && !/[.!?]$/.test(l) && !/:\s*\S/.test(l);

        if (HARD_STOP.test(l)) break;
        if (standalone && SOFT_STOP.test(l)) break;
        if (parts.length && isShoutingHeading(l)) break;
        if (ABSTRACT_HEAD.test(l)) break;
        parts.push(l);                      // no length cap
      }

      const text = joinWrapped(parts);
      candidates.push({ text, words: text.split(/\s+/).filter(Boolean).length });
    }

    // The real abstract is the longest block; a TOC mention is only a few words.
    candidates.sort((a, b) => b.words - a.words);
    const best = candidates[0];
    return best && best.words >= 15 ? best.text : "";
  }

  /* ---------------- names ---------------- */

  const TITLE_STOP = [
    /^an?$/i, /^the$/i,
    /^(?:activity|assignment|thesis|dissertation|undergraduate|capstone project|research project)\b/i,
    /^a (?:thesis|capstone|research|project|study|paper|dissertation)\b/i,
    /^(?:presented|submitted|prepared|proposed|developed)\b/i,
    /^in partial\b/i,
    /^by\s*:?$/i,
    /^(?:researchers?|proponents?|authors?|members?)\s*:?$/i,
  ];

  const AFFILIATION = /\b(corp|inc|ltd|llc|universit(?:y|é)|institute|labs?|laborator\w*|college|department|school|center|centre|faculty|campus|polytechnic|bachelor|master|doctor|degree|requirements?|fulfillment|partial|presented|submitted|manila|philippines|capstone|thesis|project|study|adviser|advisor|panel|dean|chair\w*)\b/i;

  // Lowercase words that may legitimately appear inside a person's name.
  const NAME_PARTICLES = new Set(["de", "la", "las", "los", "del", "delos", "dela", "van", "von", "der", "den", "bin", "binti", "al", "el", "di", "da", "dos", "san", "santa", "y", "jr", "sr", "ii", "iii", "iv"]);

  function isName(s) {
    const c = s.replace(/[*†‡¹²³\d]+$/u, "").trim();
    if (c.length < 4 || c.length > 60) return false;
    if (AFFILIATION.test(c)) return false;
    if (!/^[\p{Lu}][\p{L}.'’-]*(?:\s+[\p{L}.'’-]+){1,5}$/u.test(c)) return false;
    return c.split(" ").every((w) => !/^\p{Ll}/u.test(w) || NAME_PARTICLES.has(w.toLowerCase().replace(/\.$/, "")));
  }

  const titleCase = (s) => s.toLowerCase().replace(/(^|[\s.'’-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

  function cleanName(s) {
    let n = s.replace(/[*†‡¹²³\d]+$/u, "").replace(/\s+/g, " ").trim();
    // "JUAN DELA CRUZ" → "Juan Dela Cruz"; "SANTOS Maria S." → "Santos Maria S." (initials stay as-is)
    n = n.split(" ").map((w) => (w.length > 2 && w === w.toUpperCase() ? titleCase(w) : w)).join(" ");
    return n;
  }

  // "Cruz, Juan M."  /  "DELA CRUZ, Juan Miguel"  →  "Juan M. Cruz" / "Juan Miguel Dela Cruz"
  function surnameFirst(line) {
    const idx = line.indexOf(",");
    if (idx === -1 || line.indexOf(",", idx + 1) !== -1) return null;     // exactly one comma
    const left = line.slice(0, idx).trim().split(/\s+/);
    const right = line.slice(idx + 1).trim().split(/\s+/).filter(Boolean);
    if (!left[0] || right.length < 1 || right.length > 4) return null;
    const isParticle = (w) => NAME_PARTICLES.has(w.toLowerCase());
    // surname = one word, or particles followed by a final word ("dela Cruz", "DE LA CRUZ")
    if (left.length > 1 && !left.slice(0, -1).every(isParticle)) return null;
    const upperWord = (w) => /^\p{Lu}/u.test(w);
    if (!left.every((w) => upperWord(w) || isParticle(w))) return null;
    if (!right.every(upperWord)) return null;
    if (AFFILIATION.test(line)) return null;
    return cleanName(right.join(" ") + " " + left.join(" "));
  }

  function splitNameList(line) {
    if (surnameFirst(line)) return [];
    const parts = line.split(/;|,|\band\b|&/i).map((s) => s.trim()).filter(Boolean);
    const names = parts.filter(isName);
    return names.length >= 2 && names.length === parts.length ? names : [];
  }

  /* ---------------- TITLE / AUTHORS / YEAR ---------------- */

  const BY_INLINE = /^(?:by|(?:submitted|prepared|presented|developed|proposed)\s+by|researchers?|proponents?|authors?|members?)\s*:\s*(.+)$/i;
  const BY_MARKER = /^(?:by|(?:submitted|prepared|presented|developed|proposed)\s+by|researchers?|proponents?|authors?|members?)\s*:?$/i;
  const ADVISER_LABEL = /^(?:(?:thesis|capstone|research|project)\s+)?advis[eo]r\b/i;
  const ADVISER_ALONE = /^(?:(?:thesis|capstone|research|project)\s+)?advis[eo]r\s*:?$/i;   // label on its own line, name above it
  const PANEL_LABEL = /^(?:panel|panelists?|committee|dean|chair(?:person)?)\b/i;

  const MONTHS = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

  function findYear(coverText, extraText, maxYear) {
    const ok = (y) => y >= 1990 && y <= maxYear;
    const tryText = (blob) => {
      // 1) "June 12, 2025" / "June 2025" / "12 June 2025" (tolerates a glued page number: "20262")
      const dates = [...blob.matchAll(new RegExp(MONTHS + "\\.?\\s*(?:\\d{1,2}(?:st|nd|rd|th)?,?)?\\s*((?:19|20)\\d{2})\\d{0,2}\\b", "gi"))]
        .map((m) => +m[1]).filter(ok);
      const dates2 = [...blob.matchAll(new RegExp("\\b\\d{1,2}\\s+" + MONTHS + "\\.?,?\\s*((?:19|20)\\d{2})\\d{0,2}\\b", "gi"))]
        .map((m) => +m[1]).filter(ok);
      const dated = dates.concat(dates2);
      if (dated.length) return dated[dated.length - 1];

      // 2) "S.Y. 2024-2025" / "A.Y. 2024–2025" / "2024-2025"  → the later year
      const range = [...blob.matchAll(/\b((?:19|20)\d{2})\s*[-–—\/]\s*((?:19|20)\d{2})\b/g)].map((m) => +m[2]).filter(ok);
      if (range.length) return range[range.length - 1];

      // 3) "© 2025" / "Copyright 2025" / "Year: 2025"
      const tagged = [...blob.matchAll(/(?:©|\(c\)|copyright|year)\s*:?\s*((?:19|20)\d{2})\b/gi)].map((m) => +m[1]).filter(ok);
      if (tagged.length) return tagged[tagged.length - 1];

      // 4) any standalone year
      const loose = (blob.match(/\b(?:19|20)\d{2}\d{0,2}\b/g) || []).map((y) => +y.slice(0, 4)).filter(ok);
      return loose.length ? loose[loose.length - 1] : null;
    };
    return tryText(coverText) || (extraText ? tryText(extraText) : null);
  }

  function coverLines(lines) {
    // The cover is the first page. If that page is tiny (a logo page) include the next one.
    let firstBreak = lines.indexOf(PAGE);
    if (firstBreak !== -1 && firstBreak < 6) {
      firstBreak = lines.indexOf(PAGE, firstBreak + 1);
    }
    let end = firstBreak === -1 ? Math.min(lines.length, 70) : firstBreak;
    const tocIdx = lines.findIndex((l, i) => i > 3 && (/^table of contents$/i.test(l) || ABSTRACT_HEAD.test(l)));
    if (tocIdx !== -1) end = Math.min(end, tocIdx);
    return real(lines.slice(0, Math.min(end, 80)));
  }

  function parseCover(lines) {
    const head = coverLines(lines);

    /* ---- title ---- */
    let titleLines = [];
    const stopIdx = head.findIndex((l, i) => i >= 1 && i <= 14 && TITLE_STOP.some((re) => re.test(l)));
    if (stopIdx !== -1) {
      // Cover-page layout: everything above "A Capstone Project / Presented to / By …" is the title.
      titleLines = head.slice(0, Math.min(stopIdx, 6));
    } else {
      // Journal layout: title lines run until the author names begin.
      for (const l of head) {
        if (titleLines.length >= 1 && (isName(l) || splitNameList(l).length || AFFILIATION.test(l))) break;
        titleLines.push(l);
        if (titleLines.length >= 4) break;
      }
    }
    let title = titleLines.join(" ").replace(/\s+/g, " ").trim();

    /* ---- authors ---- */
    const authors = [];
    const pushName = (l) => {
      const sf = surnameFirst(l);
      if (sf) { authors.push(sf); return true; }
      const multi = splitNameList(l);
      if (multi.length) { authors.push(...multi.map(cleanName)); return true; }
      if (isName(l)) { authors.push(cleanName(l)); return true; }
      return false;
    };

    const byIdx = head.findIndex((l) => BY_MARKER.test(l) || BY_INLINE.test(l));
    let start = byIdx !== -1 ? byIdx : titleLines.length;
    if (byIdx !== -1) {
      const inline = head[byIdx].match(BY_INLINE);
      if (inline) pushName(inline[1].trim());
      start = byIdx + 1;
    }

    for (let i = start; i < head.length; i++) {
      const l = head[i];
      if (ADVISER_LABEL.test(l) || PANEL_LABEL.test(l)) break;
      if (BY_MARKER.test(l)) continue;
      const next = head[i + 1];
      if (next && ADVISER_ALONE.test(next)) break;           // name sits above a lone "Adviser" label → it's the adviser
      if (/^(?:bachelor|master|doctor)/i.test(l) || /^in partial/i.test(l)) continue;
      if (!pushName(l) && authors.length) break;             // names ended
    }
    const uniqueAuthors = [...new Map(authors.map((a) => [a.toLowerCase(), a])).values()];

    /* ---- year ---- */
    // Search the cover but not the title itself ("…2020 Forecast…" is not the submission year).
    const coverBody = head.slice(titleLines.length).join(" ");
    const maxYear = new Date().getFullYear() + 1;
    // Fallback: dated lines elsewhere in the first pages (approval sheet, etc.)
    const extra = real(lines.slice(0, 400)).join(" ");
    const year = findYear(coverBody, extra, maxYear);

    return { title, authors: uniqueAuthors, year };
  }

  /* ---------------- main ---------------- */

  function analyzeCapstone(rawText) {
    const lines = cleanLines(rawText);
    const cover = parseCover(lines);
    const abstract = findAbstract(lines);
    return {
      title: cover.title,
      authors: cover.authors,      // names as written; the dashboard formats them to APA
      year: cover.year,
      abstract,
      abstractFound: abstract.length > 0,
    };
  }

  return { analyzeCapstone };
});
