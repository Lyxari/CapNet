(() => {
  "use strict";

  const db = window.capnetDB;
  const BUCKET = "capstone-pdfs";
 const API_URL = 'https://capnet-i3gn.onrender.com';
  // Predefined tag options for the upload form's tag picker. Capstones can
  // still carry tags outside this list (e.g. from older uploads) — the
  // picker just adds those in dynamically too, see renderTagPickerOptions().
  const TAG_OPTIONS = [
    "Mobile App", "Web App", "Desktop App", "IoT", "Embedded Systems",
    "Artificial Intelligence", "Machine Learning", "Computer Vision",
    "Natural Language Processing", "Data Analytics", "Database Systems",
    "Cybersecurity", "Networking", "Cloud Computing", "DevOps",
    "Robotics", "Game Development", "UI/UX Design",
    "Augmented Reality", "Virtual Reality", "Blockchain",
    "Assistive Technology", "E-Commerce", "Educational Technology",
  ];

  let sessionUser = null;

  /* ---------------- auth guard (real Supabase session) ---------------- */

  async function requireStudentOrFaculty() {
    const { data: { user } } = await db.auth.getUser();

    if (!user) {
      window.location.href = "index.html";
      return null;
    }

    const { data: profile, error } = await db
      .from("profiles")
      .select("full_name, role, status")
      .eq("id", user.id)
      .single();

    if (error || !profile) {
      window.location.href = "index.html";
      return null;
    }

    if (profile.status === "suspended") {
      await db.auth.signOut();
      window.location.href = "index.html";
      return null;
    }

    if (profile.role === "faculty") {
      window.location.href = "faculty.html";
      return null;
    }
    if (profile.role === "admin") {
      window.location.href = "admin.html";
      return null;
    }

    return { id: user.id, email: user.email, name: profile.full_name || user.email };
  }

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  const tagClasses = ["tag--purple", "tag--teal", "tag--rust", "tag--pink", "tag--indigo"];

  /* ============================================================
     APA-style author formatting — plain string parsing, no AI
     needed. Converts "First Middle Last" into "Last, F. M." and
     joins multiple authors with commas + an ampersand before the
     last one, per APA 7th edition.

     Known limits (kept editable on purpose, so these are easy to
     hand-fix rather than silently wrong):
       - Assumes Western given-name-then-surname order.
       - A short list of common surname particles (dela, de los,
         san, etc.) catches compound Filipino/Spanish surnames like
         "Dela Cruz" or "Santa Maria", but very unusual or
         multi-part surnames may still need a manual tweak.
       - Single-word names are left alone (nothing safe to split).
     ============================================================ */

  const SURNAME_PARTICLES = [
    "de los", "de la", "de las",
    "dela", "delos", "delas",
    "san", "santa", "sto", "sta",
    "del", "de", "la", "los",
    "van der", "van de", "van", "von", "der",
    "mc", "mac",
  ];

  function formatOneAuthorApa(rawName) {
    let name = rawName.trim();
    if (!name) return "";

    // Already looks APA-formatted ("Surname, F." or "Surname, F. M.") — leave it alone.
    if (/^[\p{L}'’.-]+,\s*(?:[\p{L}]\.\s*){1,4}(?:,\s*(?:Jr\.?|Sr\.?|II|III|IV))?$/u.test(name)) {
      return name;
    }

    // Pull off a trailing suffix (Jr., III, etc.) to reattach after formatting.
    let suffix = "";
    const suffixMatch = name.match(/,?\s+(Jr\.?|Sr\.?|II|III|IV)$/i);
    if (suffixMatch) {
      suffix = ", " + suffixMatch[1].replace(/\.?$/, ".");
      name = name.slice(0, suffixMatch.index).trim();
    }

    const words = name.split(/\s+/).filter(Boolean);
    if (words.length < 2) return name; // just one word — nothing safe to split

    // Check whether the word(s) right before the last word form a
    // known surname particle (checks two-word particles first, e.g.
    // "de la", before falling back to a one-word particle like "dela").
    let surnameWords = [words[words.length - 1]];
    let firstNameWords = words.slice(0, -1);

    if (firstNameWords.length >= 2) {
      const lastTwo = firstNameWords.slice(-2).join(" ").toLowerCase();
      if (SURNAME_PARTICLES.includes(lastTwo)) {
        surnameWords = firstNameWords.slice(-2).concat(surnameWords);
        firstNameWords = firstNameWords.slice(0, -2);
      }
    }
    if (firstNameWords.length >= 1 && surnameWords.length === 1) {
      const lastOne = firstNameWords[firstNameWords.length - 1].toLowerCase();
      if (SURNAME_PARTICLES.includes(lastOne)) {
        surnameWords = [firstNameWords[firstNameWords.length - 1]].concat(surnameWords);
        firstNameWords = firstNameWords.slice(0, -1);
      }
    }

    const surname = surnameWords.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    if (firstNameWords.length === 0) return surname + suffix;

    const initials = firstNameWords.map((w) => w.charAt(0).toUpperCase() + ".").join(" ");
    return surname + ", " + initials + suffix;
  }

  function formatAuthorsApa(raw) {
    const parts = raw.split(/;|\n/).map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return "";

    const formatted = parts.map(formatOneAuthorApa);
    if (formatted.length === 1) return formatted[0];
    if (formatted.length === 2) return formatted[0] + ", & " + formatted[1];
    return formatted.slice(0, -1).join(", ") + ", & " + formatted[formatted.length - 1];
  }

  let toastTimer = null;
  function showToast(message) {
    let toast = document.querySelector(".ftoast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "ftoast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    requestAnimationFrame(() => toast.classList.add("is-visible"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
  }

  const STATUS_PILL = {
    Draft: ["pill--draft", "Draft"],
    Pending: ["pill--pending", "Pending review"],
    Approved: ["pill--approved", "Approved"],
    Rejected: ["pill--revision", "Rejected"],
  };

  async function init() {
    sessionUser = await requireStudentOrFaculty();
    if (!sessionUser) return;

    /* ---------------- personalize ---------------- */

    const first = sessionUser.name.trim().split(" ")[0];
    document.getElementById("userFirstName").textContent = first;
    document.getElementById("userName").textContent = sessionUser.name;
    document.getElementById("userInitial").textContent = first.charAt(0).toUpperCase();

    document.getElementById("signOutBtn").addEventListener("click", async () => {
      await db.auth.signOut();
      localStorage.removeItem("capnet_user");
      window.location.href = "index.html";
    });

    /* ================================================================
       Browse the public repository (unchanged behavior)
       ================================================================ */

    const searchInput = document.getElementById("searchInput");
    const chipsContainer = document.getElementById("tagFilterPanel");
    const tagFilterToggle = document.getElementById("tagFilterToggle");
    const tagFilterLabel = document.getElementById("tagFilterLabel");
    const yearFilter = document.getElementById("yearFilter");
    const resultsLabel = document.getElementById("resultsLabel");
    const emptyState = document.getElementById("emptyState");
    const resultsSection = document.getElementById("results");
    const statTotal = document.getElementById("statTotal");
    const statThisYear = document.getElementById("statThisYear");
    const statMine = document.getElementById("statMine");

    let publicCapstones = [];
    let mySubmissions = [];
    let activeTags = new Set();

    async function loadPublicCapstones() {
      const { data, error } = await db
        .from("capstones")
        .select("*")
        .eq("status", "Approved")
        .order("created_at", { ascending: false });

      if (error) {
        resultsLabel.textContent = "Couldn't load the repository right now.";
        return;
      }

      publicCapstones = data || [];
      statTotal.textContent = publicCapstones.length;
      const thisYear = new Date().getFullYear();
      statThisYear.textContent = publicCapstones.filter((c) => Number(c.year) === thisYear).length;
      renderTagFilterOptions();
      renderYearFilterOptions();
    }

    function renderTagFilterOptions() {
      // Pulled from the master TAG_OPTIONS list (not from tags currently
      // present on published capstones), so every official tag shows up
      // here even before any capstone has been tagged with it — and any
      // stray junk tag that isn't part of the official taxonomy (e.g.
      // leftover test data) never appears.
      const sortedTags = Array.from(TAG_OPTIONS).sort((a, b) => a.localeCompare(b));

      // Drop any previously active tag that's no longer part of the
      // official tag list.
      activeTags.forEach((t) => { if (!sortedTags.includes(t)) activeTags.delete(t); });

      chipsContainer.innerHTML =
        sortedTags.map((tag) => {
          const id = "tagfilt-" + tag.replace(/\W+/g, "-").toLowerCase();
          const checked = activeTags.has(tag) ? "checked" : "";
          return (
            '<label class="filterpicker__option" for="' + id + '">' +
              '<input type="checkbox" id="' + id + '" value="' + escapeHtml(tag) + '" ' + checked + '>' +
              '<span>' + escapeHtml(tag) + '</span>' +
            '</label>'
          );
        }).join("") +
        '<div class="filterpicker__divider"></div><button type="button" class="filterpicker__clear" id="tagFilterClear">Clear tags</button>';

      syncTagFilterLabel();
    }

    function syncTagFilterLabel() {
      tagFilterLabel.textContent = activeTags.size === 0
        ? "All tags"
        : activeTags.size + " tag" + (activeTags.size === 1 ? "" : "s");
    }

    function renderYearFilterOptions() {
      const years = Array.from(new Set(publicCapstones.map((c) => c.year).filter(Boolean)))
        .sort((a, b) => b - a);
      const current = yearFilter.value;
      yearFilter.innerHTML =
        '<option value="all">All years</option>' +
        years.map((y) => '<option value="' + y + '">' + y + '</option>').join("");
      if (years.includes(Number(current)) || current === "all") yearFilter.value = current;
    }

    function cardHtml(item) {
      const tagsHtml = (item.tags || [])
        .filter(Boolean)
        .map((t, i) => `<span class="tag ${tagClasses[i % tagClasses.length]}">${escapeHtml(t)}</span>`)
        .join("");

      const meta = [item.year, item.program].filter(Boolean).join(" · ");

      return (
        '<article class="card" tabindex="0" data-id="' + item.id + '">' +
          '<div class="card__top">' +
            '<h2 class="card__title">' + escapeHtml(item.title) + '</h2>' +
          '</div>' +
          '<p class="card__meta">' + escapeHtml(meta) + '</p>' +
          '<div class="card__tags">' + tagsHtml + '</div>' +
        '</article>'
      );
    }

    function applyFilters() {
      const query = searchInput.value.trim().toLowerCase();
      const year = yearFilter.value;

      const visible = publicCapstones.filter((item) => {
        const haystack = (item.title + " " + (item.tags || []).join(" ") + " " + (item.program || "")).toLowerCase();
        const matchesQuery = !query || haystack.includes(query);
        const matchesTags = activeTags.size === 0 ||
          (item.tags || []).some((t) => activeTags.has(t.trim ? t.trim() : t));
        const matchesYear = year === "all" || String(item.year) === year;
        return matchesQuery && matchesTags && matchesYear;
      });

      resultsSection.innerHTML = visible.map(cardHtml).join("");
      resultsLabel.textContent = "Showing " + visible.length + " of " + publicCapstones.length + " capstones";
      emptyState.hidden = visible.length !== 0;
      resultsSection.hidden = visible.length === 0;

      resultsSection.querySelectorAll(".card").forEach((card) => {
        card.addEventListener("click", () => openDetail(card.dataset.id));
        card.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openDetail(card.dataset.id);
          }
        });
      });
    }

    searchInput.addEventListener("input", applyFilters);
    yearFilter.addEventListener("change", applyFilters);

    tagFilterToggle.addEventListener("click", () => {
      const isOpen = chipsContainer.hidden === false;
      chipsContainer.hidden = isOpen;
      tagFilterToggle.setAttribute("aria-expanded", String(!isOpen));
    });

    chipsContainer.addEventListener("click", (e) => {
      if (e.target.id === "tagFilterClear") {
        activeTags.clear();
        renderTagFilterOptions();
        applyFilters();
      }
    });

    chipsContainer.addEventListener("change", (e) => {
      const cb = e.target.closest('input[type="checkbox"]');
      if (!cb) return;
      if (cb.checked) activeTags.add(cb.value);
      else activeTags.delete(cb.value);
      syncTagFilterLabel();
      applyFilters();
    });

    document.addEventListener("click", (e) => {
      if (!chipsContainer.hidden && !e.target.closest("#tagFilterPicker")) {
        chipsContainer.hidden = true;
        tagFilterToggle.setAttribute("aria-expanded", "false");
      }
    });

    document.getElementById("clearFiltersBtn").addEventListener("click", () => {
      searchInput.value = "";
      activeTags.clear();
      yearFilter.value = "all";
      renderTagFilterOptions();
      applyFilters();
    });

    /* ================================================================
       Your submissions (real data — upload, edit, delete, resubmit)
       ================================================================ */

    const uploadedCount = document.getElementById("uploadedCount");
    const uploadedList = document.getElementById("uploadedList");
    const uploadedEmpty = document.getElementById("uploadedEmpty");

    async function loadMySubmissions() {
      const { data, error } = await db
        .from("capstones")
        .select("*")
        .eq("uploaded_by", sessionUser.id)
        .order("created_at", { ascending: false });

      if (error) {
        showToast("Couldn't load your submissions: " + error.message);
        mySubmissions = [];
        return;
      }
      mySubmissions = data || [];
      statMine.textContent = mySubmissions.length;
    }

    function renderMySubmissions() {
      uploadedList.innerHTML = "";

      mySubmissions.forEach((item) => {
        const article = document.createElement("article");
        article.className = "ucard";
        article.dataset.id = item.id;

        const tagsHtml = (item.tags || [])
          .filter(Boolean)
          .map((t, i) => `<span class="tag ${tagClasses[i % tagClasses.length]}">${escapeHtml(t)}</span>`)
          .join("");

        const [pillClass, pillLabel] = STATUS_PILL[item.status] || ["pill--draft", item.status];
        const feedback = item.status === "Rejected" && item.review_note
          ? '<p class="ucard__meta" style="margin-top:6px; color:var(--rust-dark);">Reviewer note: ' + escapeHtml(item.review_note) + '</p>'
          : "";

        article.innerHTML =
          '<div class="ucard__top">' +
            '<div>' +
              '<p class="ucard__title">' + escapeHtml(item.title) + '</p>' +
              '<p class="ucard__meta">' + escapeHtml(item.authors) + ' &middot; ' + escapeHtml(item.year || "—") +
                (item.adviser ? ' &middot; ' + escapeHtml(item.adviser) : '') + '</p>' +
              feedback +
            '</div>' +
            '<span class="pill ' + pillClass + '">' + pillLabel + '</span>' +
          '</div>' +
          '<div class="ucard__tags">' + tagsHtml + '</div>' +
          '<div class="ucard__actions">' +
            '<button type="button" class="btn btn--ghost btn--sm" data-view>View details</button>' +
            '<button type="button" class="btn btn--ghost btn--sm" data-delete>Delete</button>' +
          '</div>';

        uploadedList.appendChild(article);
      });

      uploadedCount.textContent = mySubmissions.length;
      uploadedEmpty.hidden = mySubmissions.length !== 0;
    }

    uploadedList.addEventListener("click", async (e) => {
      const card = e.target.closest(".ucard");
      if (!card) return;
      const item = mySubmissions.find((u) => u.id === card.dataset.id);
      if (!item) return;

      if (e.target.closest("[data-view]")) {
        openDetail(item.id);
        return;
      }
      if (e.target.closest("[data-delete]")) {
        if (!confirm("Are you sure you want to delete this submission?")) return;
        const { error } = await db.from("capstones").delete().eq("id", item.id);
        if (error) {
          showToast("Couldn't delete: " + error.message);
          return;
        }
        await loadMySubmissions();
        renderMySubmissions();
        showToast("Submission deleted");
        return;
      }
    });

    const uploadStepEl = document.getElementById("uploadStep");
    const uploadStepFile = document.getElementById("uploadStepFile");
    const uploadStepProcessing = document.getElementById("uploadStepProcessing");
    const uploadStepExtracted = document.getElementById("uploadStepExtracted");
    const dropzone = document.getElementById("dropzone");
    const fileInput = document.getElementById("fileInput");
    const dropzoneFile = document.getElementById("dropzoneFile");

    const aiFileName = document.getElementById("aiFileName");
    const downloadAiSummaryBtn = document.getElementById("downloadAiSummaryBtn");
    const uploadCancelBtn = document.getElementById("uploadCancelBtn");
    const submitExtractedForReviewBtn = document.getElementById("submitExtractedForReviewBtn");

    const aiExtractedTitle = document.getElementById("aiExtractedTitle");
    const aiExtractedAuthors = document.getElementById("aiExtractedAuthors");
    const aiExtractedAdviser = document.getElementById("aiExtractedAdviser");
    const aiExtractedDate = document.getElementById("aiExtractedDate");
    const aiExtractedProgram = document.getElementById("aiExtractedProgram");
    const aiExtractedAbstract = document.getElementById("aiExtractedAbstract");

    let lastFocused2 = null;
    const overlay2 = document.getElementById("uploadOverlay");
    const modal2 = document.getElementById("uploadModal");
    const openUploadBtn = document.getElementById("openUploadBtn");
    const uploadClose = document.getElementById("uploadClose");
    let selectedFile = null;
    let extractedData = null;
    let generatedFileContent = "";
    let generatedFileName = "";
    let selectedUploadTags = new Set();

    const uploadTagGrid = document.getElementById("uploadTagGrid");

    function renderUploadTagPicker() {
      uploadTagGrid.innerHTML = TAG_OPTIONS
        .sort((a, b) => a.localeCompare(b))
        .map((tag) => {
          const id = "uptag-" + tag.replace(/\W+/g, "-").toLowerCase();
          const selected = selectedUploadTags.has(tag) ? "is-selected" : "";
          return (
            '<label class="' + selected + '" for="' + id + '">' +
              '<input type="checkbox" id="' + id + '" value="' + escapeHtml(tag) + '"' + (selected ? ' checked' : '') + '>' +
              escapeHtml(tag) +
            '</label>'
          );
        }).join("");
    }

    uploadTagGrid.addEventListener("change", (e) => {
      const cb = e.target.closest('input[type="checkbox"]');
      if (!cb) return;
      if (cb.checked) selectedUploadTags.add(cb.value);
      else selectedUploadTags.delete(cb.value);
      cb.closest("label").classList.toggle("is-selected", cb.checked);
    });

    function resetUploadModal() {
      selectedFile = null;
      extractedData = null;
      generatedFileContent = "";
      generatedFileName = "";
      selectedUploadTags.clear();
      uploadStepFile.hidden = false;
      if (uploadStepProcessing) uploadStepProcessing.hidden = true;
      if (uploadStepExtracted) uploadStepExtracted.hidden = true;
      dropzoneFile.hidden = true;
      dropzoneFile.textContent = "";
      fileInput.value = "";
      uploadStepEl.textContent = "Step 1 of 2 · Select the manuscript";
    }

    function openUploadModal() {
      lastFocused2 = document.activeElement;
      resetUploadModal();

      overlay2.hidden = false;
      void overlay2.offsetWidth;
      overlay2.classList.add("is-open");
      modal2.hidden = false;
      requestAnimationFrame(() => modal2.classList.add("is-visible"));
      document.addEventListener("keydown", onUploadKeydown);
    }

    function closeUploadModal() {
      modal2.classList.remove("is-visible");
      overlay2.classList.remove("is-open");
      setTimeout(() => {
        modal2.hidden = true;
        overlay2.hidden = true;
      }, 320);
      document.removeEventListener("keydown", onUploadKeydown);
      if (lastFocused2) lastFocused2.focus();
    }

    function onUploadKeydown(e) {
      if (e.key === "Escape") closeUploadModal();
    }

    openUploadBtn.addEventListener("click", () => openUploadModal());
    uploadClose.addEventListener("click", closeUploadModal);
    if (uploadCancelBtn) uploadCancelBtn.addEventListener("click", closeUploadModal);
    overlay2.addEventListener("click", (e) => {
      if (e.target === overlay2) closeUploadModal();
    });

    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("is-dragover");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-dragover"));
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-dragover");
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
    });

    function titleCaseFromFilename(name) {
      const base = name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
      return base.replace(/\b\w/g, (c) => c.toUpperCase());
    }

    /* (Client-side NLP parser removed — extraction is now handled by
       Google Gemini AI on the server via POST /api/nlp/process-capstone) */

    /* Generate a PDF summary using jsPDF instead of plain text */
    function downloadSummaryPdf(meta, filename) {
      if (!window.jspdf || !window.jspdf.jsPDF) {
        showToast("PDF library not loaded yet. Please try again in a moment.");
        return;
      }
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: "mm", format: "a4" });
      const pw = doc.internal.pageSize.getWidth();
      const margin = 20;
      const usable = pw - margin * 2;
      let y = 25;

      function addText(text, size, style, maxW, lineH) {
        doc.setFontSize(size);
        doc.setFont("helvetica", style || "normal");
        const split = doc.splitTextToSize(String(text || "—"), maxW || usable);
        split.forEach((line) => {
          if (y > 270) { doc.addPage(); y = 20; }
          doc.text(line, margin, y);
          y += (lineH || size * 0.45);
        });
      }

      function addField(label, value) {
        doc.setFontSize(9);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(100, 100, 100);
        if (y > 270) { doc.addPage(); y = 20; }
        doc.text(label.toUpperCase(), margin, y);
        y += 5;
        doc.setFont("helvetica", "normal");
        doc.setTextColor(30, 30, 30);
        doc.setFontSize(11);
        const split = doc.splitTextToSize(String(value || "—"), usable);
        split.forEach((line) => {
          if (y > 270) { doc.addPage(); y = 20; }
          doc.text(line, margin, y);
          y += 5;
        });
        y += 4;
      }

      // Header
      doc.setFillColor(40, 40, 44);
      doc.rect(0, 0, pw, 42, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(18);
      doc.setFont("helvetica", "bold");
      doc.text("CapNet AI Extraction Report", margin, 18);
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.text("Source: " + (filename || "—"), margin, 27);
      doc.text("Extracted: " + new Date().toLocaleString(), margin, 34);

      y = 52;
      doc.setTextColor(30, 30, 30);

      addField("Title", meta.title);
      addField("Authors", meta.authors);
      addField("Adviser", meta.adviser);
      addField("Year", String(meta.year));
      addField("Program", meta.program);
      addField("Tags", (meta.tags || []).join(", ") || "None detected");

      // Abstract
      doc.setDrawColor(200, 200, 200);
      doc.line(margin, y, pw - margin, y);
      y += 8;
      addField("Abstract", meta.abstract);

      // Footer
      y += 6;
      if (y > 270) { doc.addPage(); y = 20; }
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text("Generated by CapNet AI Document Intelligence. Awaiting faculty review.", margin, y);

      const pdfName = (filename || "capstone").replace(/\.pdf$/i, "") + "_extracted_summary.pdf";
      doc.save(pdfName);
      return pdfName;
    }

    if (downloadAiSummaryBtn) {
      downloadAiSummaryBtn.addEventListener("click", () => {
        if (!extractedData) return;
        const savedName = downloadSummaryPdf(extractedData, selectedFile ? selectedFile.name : "capstone.pdf");
        showToast("PDF summary downloaded: " + savedName);
      });
    }

    async function handleFile(file) {
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      if (!isPdf) { showToast("Please upload a PDF manuscript."); return; }
      if (file.size > 25 * 1024 * 1024) { showToast("That PDF is over the 25MB limit."); return; }

      selectedFile = file;
      dropzoneFile.hidden = false;
      dropzoneFile.textContent = file.name + " · " + (file.size / 1024 / 1024).toFixed(1) + " MB";

      uploadStepFile.hidden = true;
      if (uploadStepExtracted) uploadStepExtracted.hidden = true;
      if (uploadStepProcessing) uploadStepProcessing.hidden = false;
      uploadStepEl.textContent = "Step 2 of 2 · AI Manuscript Extraction in Progress…";

      let parsedResult = null;

      // Send the PDF to the Gemini-powered backend for AI extraction
      try {
        const formData = new FormData();
        formData.append("pdf", file);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s for AI processing

        const response = await fetch(API_URL + "/api/nlp/process-capstone", {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errBody = await response.json().catch(() => ({}));
          throw new Error(errBody.error || "Server returned " + response.status);
        }

        const jsonRes = await response.json();
        const r = jsonRes.data || jsonRes;

        parsedResult = {
          title: r.title || titleCaseFromFilename(file.name),
          authors: r.authors ? formatAuthorsApa(r.authors) : "",
          adviser: r.adviser || "",
          year: r.year || null,
          program: r.program || "",
          abstract: r.abstract || "",
          tags: [],         // Tags are selected manually by the student
        };
      } catch (err) {
        console.error("Gemini AI extraction failed:", err);
        showToast("AI extraction failed: " + err.message);

        // Minimal fallback — just fill in what we can from the filename
        parsedResult = {
          title: titleCaseFromFilename(file.name),
          authors: "",
          adviser: "",
          year: null,
          program: "",
          abstract: "",
          tags: [],
        };
      }

      extractedData = parsedResult;

      // Prepare the generated filename for the PDF summary
      const baseName = file.name.replace(/\.pdf$/i, "").replace(/\s+/g, "_");
      generatedFileName = `${baseName}_extracted_summary.pdf`;

      // Update UI preview
      if (aiExtractedTitle) aiExtractedTitle.textContent = extractedData.title || "—";
      if (aiExtractedAuthors) aiExtractedAuthors.textContent = extractedData.authors || "—";
      if (aiExtractedAdviser) aiExtractedAdviser.textContent = extractedData.adviser || "—";
      if (aiExtractedDate) aiExtractedDate.textContent = String(extractedData.year || "—");
      if (aiExtractedProgram) aiExtractedProgram.textContent = extractedData.program || "—";
      if (aiExtractedAbstract) aiExtractedAbstract.textContent = extractedData.abstract || "—";
      if (aiFileName) aiFileName.textContent = generatedFileName;

      // Render the tag picker so the student can select tags manually
      selectedUploadTags.clear();
      renderUploadTagPicker();

      if (uploadStepProcessing) uploadStepProcessing.hidden = true;
      if (uploadStepExtracted) uploadStepExtracted.hidden = false;
      uploadStepEl.textContent = "Step 2 of 2 · AI Extraction Complete — Select tags below";

      showToast("AI extraction complete! Select tags and review the results.");
    }

    async function uploadPdfFile() {
      if (!selectedFile) return null;
      const path = sessionUser.id + "/" + Date.now() + "-" + selectedFile.name.replace(/\s+/g, "_");
      const { error } = await db.storage.from(BUCKET).upload(path, selectedFile);
      if (error) {
        console.warn("Storage upload notice:", error.message);
      }
      return path;
    }

    if (submitExtractedForReviewBtn) {
      submitExtractedForReviewBtn.addEventListener("click", async () => {
        if (!extractedData) {
          showToast("No extracted data found. Please select a PDF manuscript.");
          return;
        }

        submitExtractedForReviewBtn.disabled = true;
        submitExtractedForReviewBtn.textContent = "Submitting…";

        try {
          const filePath = await uploadPdfFile();

          // Submissions start with status 'Pending' so the teacher can review and approve it.
          // If approved by the teacher, it is marked 'Approved' and published to the database repository!
          // Use the manually-selected tags from the tag picker
          const payload = {
            title: extractedData.title,
            authors: extractedData.authors,
            adviser: extractedData.adviser,
            year: extractedData.year,
            program: extractedData.program,
            abstract: extractedData.abstract,
            tags: Array.from(selectedUploadTags),
            status: "Pending",
            file_path: filePath,
            uploaded_by: sessionUser.id,
          };

          const { data, error } = await db.from("capstones").insert(payload).select().single();
          if (error) throw error;

          await loadMySubmissions();
          renderMySubmissions();
          showToast('Submitted "' + data.title + '" for teacher approval!');
          closeUploadModal();
        } catch (err) {
          showToast("Submission error: " + (err.message || "Could not submit"));
        } finally {
          submitExtractedForReviewBtn.disabled = false;
          submitExtractedForReviewBtn.textContent = "Submit for Review";
        }
      });
    }

    /* ================================================================
       Detail modal — shared by both public browse results and your
       own submissions, so it needs to look items up in either list.
       ================================================================ */

    const overlay = document.getElementById("overlay");
    const modal = document.getElementById("detailModal");
    let lastFocused = null;
    let openItem = null;

    function findById(id) {
      return publicCapstones.find((c) => String(c.id) === String(id)) ||
             mySubmissions.find((c) => String(c.id) === String(id));
    }

    function openDetail(id) {
      const item = findById(id);
      if (!item) return;
      openItem = item;

      lastFocused = document.activeElement;

      document.getElementById("detail-title").textContent = item.title;
      const meta = [item.year, item.program].filter(Boolean).join(" · ");
      document.getElementById("detailMeta").textContent = meta;
      document.getElementById("detailAbstract").textContent = item.abstract || "No abstract provided.";
      document.getElementById("detailAuthors").textContent = item.authors || "—";
      document.getElementById("detailAdviser").textContent = item.adviser || "—";
      document.getElementById("detailNote").textContent = "";

      const statusEl = document.getElementById("detailStatus");
      const [pillClass, pillLabel] = STATUS_PILL[item.status] || ["", item.status];
      statusEl.textContent = pillLabel;
      statusEl.className = "detail__status " + (item.status === "Pending" ? "is-pending" : "");

      const feedbackBlock = document.getElementById("detailFeedbackBlock");
      if (item.status === "Rejected" && item.review_note) {
        feedbackBlock.hidden = false;
        document.getElementById("detailFeedback").textContent = item.review_note;
      } else {
        feedbackBlock.hidden = true;
      }

      const tagWrap = document.getElementById("detailTags");
      tagWrap.innerHTML = "";
      (item.tags || []).forEach((t, i) => {
        const span = document.createElement("span");
        span.className = `tag ${tagClasses[i % tagClasses.length]}`;
        span.textContent = t;
        tagWrap.appendChild(span);
      });



      overlay.hidden = false;
      void overlay.offsetWidth;
      overlay.classList.add("is-open");
      modal.hidden = false;
      requestAnimationFrame(() => modal.classList.add("is-visible"));

      document.addEventListener("keydown", onKeydown);
    }

    function closeDetail() {
      modal.classList.remove("is-visible");
      overlay.classList.remove("is-open");
      setTimeout(() => {
        modal.hidden = true;
        overlay.hidden = true;
      }, 320);
      document.removeEventListener("keydown", onKeydown);
      if (lastFocused) lastFocused.focus();
    }

    function onKeydown(e) {
      if (e.key === "Escape") closeDetail();
    }

    document.getElementById("detailClose").addEventListener("click", closeDetail);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeDetail();
    });

    document.getElementById("detailDownloadBtn").addEventListener("click", async () => {
      const noteEl = document.getElementById("detailNote");
      if (!openItem || !openItem.file_path) {
        noteEl.textContent = "No file is attached to this record.";
        return;
      }
      noteEl.textContent = "Preparing download…";
      const { data, error } = await db.storage.from(BUCKET).createSignedUrl(openItem.file_path, 60);
      if (error || !data) {
        noteEl.textContent = "Couldn't generate a download link.";
        return;
      }
      noteEl.textContent = "";
      window.open(data.signedUrl, "_blank");
    });

 await Promise.all([loadPublicCapstones(), loadMySubmissions()]);
  applyFilters();
  renderMySubmissions();
}

init();
})();
