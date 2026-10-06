(() => {
  "use strict";

  const db = window.capnetDB;
  const BUCKET = "capstone-pdfs";

  // Same predefined tag list as dashboard.js — kept identical so the tag
  // filter shows the same options on both the student and faculty pages.
  const TAG_OPTIONS = [
    "Mobile App", "Web App", "Desktop App", "IoT", "Embedded Systems",
    "Artificial Intelligence", "Machine Learning", "Computer Vision",
    "Natural Language Processing", "Data Analytics", "Database Systems",
    "Cybersecurity", "Networking", "Cloud Computing", "DevOps",
    "Robotics", "Game Development", "UI/UX Design",
    "Augmented Reality", "Virtual Reality", "Blockchain",
    "Assistive Technology", "E-Commerce", "Educational Technology",
  ];

  let sessionUser = null; // { id, email, name }

  /* ---------------- auth guard (real Supabase session) ---------------- */

  async function requireFaculty() {
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

    if (profile.role !== "faculty") {
      window.location.href = profile.role === "admin" ? "admin.html" : "dashboard.html";
      return null;
    }

    return { id: user.id, email: user.email, name: profile.full_name || user.email };
  }

  /* ---------------- toast ---------------- */

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

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  const tagClasses = ["tag--purple", "tag--teal", "tag--rust", "tag--pink", "tag--indigo"];

  const STATUS_PILL = {
    Pending: ["pill--pending", "Pending review"],
    Approved: ["pill--approved", "Approved"],
    Rejected: ["pill--revision", "Rejected"],
  };

  /* ============================================================
     Everything below only runs once we know the person is a
     signed-in faculty account. This is a SHARED review queue —
     any faculty account can act on any pending submission, since
     there's no per-adviser linkage in the data (that would need an
     adviser_id column, which this build deliberately avoids).
     ============================================================ */

  async function init() {
    sessionUser = await requireFaculty();
    if (!sessionUser) return;

    /* ---------------- personalize ---------------- */

    const first = sessionUser.name.trim().split(" ")[0];
    document.getElementById("userFirstName").textContent = sessionUser.name;
    document.getElementById("userName").textContent = sessionUser.name;
    document.getElementById("userInitial").textContent = first.charAt(0).toUpperCase();

    document.getElementById("signOutBtn").addEventListener("click", async () => {
      await db.auth.signOut();
      localStorage.removeItem("capnet_user");
      window.location.href = "index.html";
    });

    /* ---------------- load real data (shared queue, all submissions) ---------------- */

    const statPending = document.getElementById("statPending");
    const statApproved = document.getElementById("statApproved");
    const statRejected = document.getElementById("statRejected");
    const pendingCount = document.getElementById("pendingCount");
    const pendingList = document.getElementById("pendingList");
    const pendingEmpty = document.getElementById("pendingEmpty");
    const reviewedCount = document.getElementById("reviewedCount");
    const reviewedList = document.getElementById("reviewedList");
    const reviewedEmpty = document.getElementById("reviewedEmpty");
    const searchInput = document.getElementById("searchInput");
    const chipsContainer = document.getElementById("tagFilterPanel");
    const tagFilterToggle = document.getElementById("tagFilterToggle");
    const tagFilterLabel = document.getElementById("tagFilterLabel");
    const yearFilter = document.getElementById("yearFilter");

    let pending = [];
    let reviewed = [];
    let activeTags = new Set();

    function renderTagChips() {
      const tagSet = new Set(TAG_OPTIONS);
      pending.concat(reviewed).forEach((item) => {
        (item.tags || []).forEach((t) => {
          if (t && t.trim()) tagSet.add(t.trim());
        });
      });
      const sortedTags = Array.from(tagSet).sort((a, b) => a.localeCompare(b));

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
        (sortedTags.length
          ? '<div class="filterpicker__divider"></div><button type="button" class="filterpicker__clear" id="tagFilterClear">Clear tags</button>'
          : '<p class="qlist__empty" style="padding:8px;">No tags yet.</p>');

      syncTagFilterLabel();
    }

    function syncTagFilterLabel() {
      tagFilterLabel.textContent = activeTags.size === 0
        ? "All tags"
        : activeTags.size + " tag" + (activeTags.size === 1 ? "" : "s");
    }

    function renderYearFilterOptions() {
      const years = Array.from(new Set(pending.concat(reviewed).map((c) => c.year).filter(Boolean)))
        .sort((a, b) => b - a);
      const current = yearFilter.value;
      yearFilter.innerHTML =
        '<option value="all">All years</option>' +
        years.map((y) => '<option value="' + y + '">' + y + '</option>').join("");
      if (years.includes(Number(current)) || current === "all") yearFilter.value = current;
    }

    function matchesFilter(item) {
      const query = searchInput.value.trim().toLowerCase();
      const haystack = (item.title + " " + item.authors + " " + (item.tags || []).join(" ")).toLowerCase();
      const matchesQuery = !query || haystack.includes(query);
      const matchesTags = activeTags.size === 0 ||
        (item.tags || []).some((t) => activeTags.has(t.trim ? t.trim() : t));
      const matchesYear = yearFilter.value === "all" || String(item.year) === yearFilter.value;
      return matchesQuery && matchesTags && matchesYear;
    }

    async function loadAll() {
      const { data, error } = await db
        .from("capstones")
        .select("*")
        .order("created_at", { ascending: true });

      if (error) {
        showToast("Couldn't load the review queue: " + error.message);
        pending = [];
        reviewed = [];
        return;
      }

      const all = data || [];
      pending = all.filter((c) => c.status === "Pending");
      reviewed = all.filter((c) => c.status === "Approved" || c.status === "Rejected").reverse();
    }

    function renderStats() {
      statPending.textContent = pending.length;
      statApproved.textContent = reviewed.filter((c) => c.status === "Approved").length;
      statRejected.textContent = reviewed.filter((c) => c.status === "Rejected").length;
    }

    function pendingCardHtml(item) {
      const tagsHtml = (item.tags || [])
        .filter(Boolean)
        .map((t, i) => `<span class="tag ${tagClasses[i % tagClasses.length]}">${escapeHtml(t)}</span>`)
        .join("");

      return (
        '<article class="qcard" data-id="' + item.id + '">' +
          '<div class="qcard__top">' +
            '<div>' +
              '<p class="qcard__title">' + escapeHtml(item.title) + '</p>' +
              '<p class="qcard__meta">Submitted by ' + escapeHtml(item.authors) + ' &middot; ' + escapeHtml(item.year || "—") +
                (item.adviser ? ' &middot; Adviser: ' + escapeHtml(item.adviser) : '') + '</p>' +
            '</div>' +
            '<span class="pill pill--pending">Pending review</span>' +
          '</div>' +
          '<div class="qcard__tags">' + tagsHtml + '</div>' +
          '<div class="qcard__actions">' +
            '<button type="button" class="btn btn--ghost btn--sm" data-view>View details</button>' +
            '<button type="button" class="btn btn--dark btn--sm" data-approve>Approve</button>' +
            '<button type="button" class="btn btn--ghost btn--sm" data-deny>Deny with reason</button>' +
          '</div>' +
          '<div class="qcard__revise-panel" hidden>' +
            '<label class="revise-field">' +
              '<span>Why is this being sent back?</span>' +
              '<textarea rows="3" placeholder="e.g. Chapter 3 methodology needs more detail before this can be indexed."></textarea>' +
            '</label>' +
            '<div class="qcard__revise-actions">' +
              '<button type="button" class="btn btn--ghost btn--sm" data-cancel-deny>Cancel</button>' +
              '<button type="button" class="btn btn--dark btn--sm" data-send-deny>Send decision</button>' +
            '</div>' +
          '</div>' +
        '</article>'
      );
    }

    function reviewedCardHtml(item) {
      const [pillClass, pillLabel] = STATUS_PILL[item.status] || ["", item.status];
      const note = item.status === "Rejected" && item.review_note
        ? '<p class="tcard__meta" style="color:var(--rust-dark);">Note: ' + escapeHtml(item.review_note) + '</p>'
        : "";

      return (
        '<article class="tcard" data-id="' + item.id + '">' +
          '<div class="tcard__top">' +
            '<p class="tcard__title">' + escapeHtml(item.title) + '</p>' +
            '<span class="pill ' + pillClass + '">' + pillLabel + '</span>' +
          '</div>' +
          '<p class="tcard__meta">' + escapeHtml(item.authors) + ' &middot; ' + escapeHtml(item.year || "—") + '</p>' +
          note +
          '<button type="button" class="btn btn--ghost btn--sm" data-view>View details</button>' +
        '</article>'
      );
    }

    function renderLists() {
      const filteredPending = pending.filter(matchesFilter);
      const filteredReviewed = reviewed.filter(matchesFilter);
      const filterActive = activeTags.size > 0 || yearFilter.value !== "all" || searchInput.value.trim() !== "";

      pendingList.innerHTML = filteredPending.map(pendingCardHtml).join("");
      pendingCount.textContent = filteredPending.length;
      pendingEmpty.hidden = filteredPending.length !== 0;
      pendingEmpty.textContent = filterActive
        ? "Nothing matches your search."
        : "Nothing waiting right now — new submissions will show up here.";

      reviewedList.innerHTML = filteredReviewed.map(reviewedCardHtml).join("");
      reviewedCount.textContent = filteredReviewed.length;
      reviewedEmpty.hidden = filteredReviewed.length !== 0;
      reviewedEmpty.textContent = filterActive
        ? "Nothing matches your search."
        : "Once a submission is approved or rejected, it'll show up here.";

      renderStats();
    }

    searchInput.addEventListener("input", renderLists);
    yearFilter.addEventListener("change", renderLists);

    tagFilterToggle.addEventListener("click", () => {
      const isOpen = chipsContainer.hidden === false;
      chipsContainer.hidden = isOpen;
      tagFilterToggle.setAttribute("aria-expanded", String(!isOpen));
    });

    chipsContainer.addEventListener("click", (e) => {
      if (e.target.id === "tagFilterClear") {
        activeTags.clear();
        renderTagChips();
        renderLists();
      }
    });

    chipsContainer.addEventListener("change", (e) => {
      const cb = e.target.closest('input[type="checkbox"]');
      if (!cb) return;
      if (cb.checked) activeTags.add(cb.value);
      else activeTags.delete(cb.value);
      syncTagFilterLabel();
      renderLists();
    });

    document.addEventListener("click", (e) => {
      if (!chipsContainer.hidden && !e.target.closest("#tagFilterPicker")) {
        chipsContainer.hidden = true;
        tagFilterToggle.setAttribute("aria-expanded", "false");
      }
    });

    /* ---------------- approve / deny (single source of truth) ---------------- */

    async function decide(item, status, note) {
      const { error } = await db
        .from("capstones")
        .update({ status, review_note: note || null })
        .eq("id", item.id);

      if (error) {
        showToast("Couldn't save your decision: " + error.message);
        return false;
      }

      item.status = status;
      item.review_note = note || null;
      pending = pending.filter((p) => p.id !== item.id);
      reviewed = reviewed.filter((r) => r.id !== item.id);
      reviewed.unshift(item);
      renderLists();
      return true;
    }

    pendingList.addEventListener("click", async (e) => {
      const card = e.target.closest(".qcard");
      if (!card) return;
      const item = pending.find((p) => p.id === card.dataset.id);
      if (!item) return;

      if (e.target.closest("[data-view]")) {
        openDetail(item.id);
        return;
      }

      if (e.target.closest("[data-approve]")) {
        const ok = await decide(item, "Approved", null);
        if (ok) showToast('Approved "' + item.title + '"');
        return;
      }

      if (e.target.closest("[data-deny]")) {
        card.querySelector(".qcard__revise-panel").hidden = false;
        card.querySelector("textarea").focus();
        return;
      }

      if (e.target.closest("[data-cancel-deny]")) {
        const panel = card.querySelector(".qcard__revise-panel");
        panel.hidden = true;
        panel.querySelector("textarea").value = "";
        return;
      }

      if (e.target.closest("[data-send-deny]")) {
        const textarea = card.querySelector("textarea");
        const note = textarea.value.trim();
        if (!note) {
          textarea.focus();
          textarea.style.borderColor = "var(--rust)";
          return;
        }
        const ok = await decide(item, "Rejected", note);
        if (ok) showToast('Sent back "' + item.title + '" with a note');
        return;
      }
    });

    reviewedList.addEventListener("click", (e) => {
      const card = e.target.closest(".tcard");
      if (!card) return;
      if (e.target.closest("[data-view]")) openDetail(card.dataset.id);
    });

    /* ================================================================
       Detail modal — read-only info, plus Approve/Deny when the item
       is still Pending.
       ================================================================ */

    const overlay = document.getElementById("overlay");
    const modal = document.getElementById("detailModal");
    let lastFocused = null;
    let openItem = null;

    function findById(id) {
      return pending.find((c) => String(c.id) === String(id)) ||
             reviewed.find((c) => String(c.id) === String(id));
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



      document.getElementById("detailReviewActions").hidden = item.status !== "Pending";
      document.getElementById("detailDenyPanel").hidden = true;
      document.getElementById("detailDenyNote").value = "";

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

    document.getElementById("detailApproveBtn").addEventListener("click", async () => {
      const ok = await decide(openItem, "Approved", null);
      if (ok) {
        showToast('Approved "' + openItem.title + '"');
        closeDetail();
      }
    });

    document.getElementById("detailDenyBtn").addEventListener("click", () => {
      document.getElementById("detailDenyPanel").hidden = false;
      document.getElementById("detailDenyNote").focus();
    });

    document.getElementById("detailDenyCancel").addEventListener("click", () => {
      document.getElementById("detailDenyPanel").hidden = true;
      document.getElementById("detailDenyNote").value = "";
    });

    document.getElementById("detailDenySend").addEventListener("click", async () => {
      const textarea = document.getElementById("detailDenyNote");
      const note = textarea.value.trim();
      if (!note) {
        textarea.focus();
        textarea.style.borderColor = "var(--rust)";
        return;
      }
      const ok = await decide(openItem, "Rejected", note);
      if (ok) {
        showToast('Sent back "' + openItem.title + '" with a note');
        closeDetail();
      }
    });

    /* ---------------- init ---------------- */

    await loadAll();
    renderTagChips();
    renderYearFilterOptions();
    renderLists();
  }

  init();
})();