(() => {
  "use strict";

  const db = window.capnetDB;

  let sessionUser = null; // { id, email, name }

  /* ---------------- auth guard (real Supabase session) ---------------- */

  async function requireAdmin() {
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

    if (profile.role !== "admin") {
      window.location.href = profile.role === "faculty" ? "faculty.html" : "dashboard.html";
      return null;
    }

    return { id: user.id, email: user.email, name: profile.full_name || user.email };
  }

  /* ---------------- helpers ---------------- */

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : str;
    return div.innerHTML;
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
    toastTimer = setTimeout(() => {
      toast.classList.remove("is-visible");
    }, 2600);
  }

  const ROLE_LABEL = { student: "Student", faculty: "Faculty", admin: "Admin" };
  const TAG_CLASSES = ["tag--teal", "tag--purple", "tag--indigo", "tag--pink", "tag--rust"];

  async function init() {
    sessionUser = await requireAdmin();
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

    /* ---------------- accounts (real profiles table) ---------------- */

    const tbody = document.getElementById("userTableBody");
    const userCount = document.getElementById("userCount");
    const statUsers = document.getElementById("statUsers");
    const userEmpty = document.getElementById("userEmpty");
    const userSearch = document.getElementById("userSearch");
    const roleFilter = document.getElementById("roleFilter");

    let accounts = [];

    async function loadAccounts() {
      const { data, error } = await db
        .from("profiles")
        .select("id, full_name, email, role, status")
        .order("full_name", { ascending: true });

      if (error) {
        showToast("Couldn't load accounts: " + error.message);
        accounts = [];
        return;
      }
      accounts = data || [];
    }

    function renderUsers() {
      const query = userSearch.value.trim().toLowerCase();
      const role = roleFilter.value;

      const filtered = accounts.filter((a) => {
        if (role !== "all" && a.role !== role) return false;
        if (!query) return true;
        return (
          (a.full_name || "").toLowerCase().includes(query) ||
          (a.email || "").toLowerCase().includes(query)
        );
      });

      userCount.textContent = filtered.length;
      statUsers.textContent = accounts.length;

      tbody.innerHTML = "";
      userEmpty.hidden = filtered.length !== 0;

      filtered.forEach((account) => {
        const tr = document.createElement("tr");

        const isSelf = account.id === sessionUser.id;
        const status = account.status === "suspended" ? "suspended" : "active";
        const statusClass = status === "suspended" ? "statuspill--suspended" : "statuspill--active";
        const statusLabel = status === "suspended" ? "Suspended" : "Active";
        const toggleLabel = status === "suspended" ? "Reactivate" : "Suspend";
        const displayName = account.full_name || account.email || "—";

        tr.innerHTML =
          '<td class="atable__name">' + escapeHtml(displayName) +
            (isSelf ? ' <span style="color:var(--ink-30); font-weight:500;">(you)</span>' : '') + '</td>' +
          '<td class="atable__email">' + escapeHtml(account.email || "—") + '</td>' +
          '<td></td>' +
          '<td><span class="statuspill ' + statusClass + '">' + statusLabel + '</span></td>' +
          '<td class="atable__actions">' +
            '<button type="button" class="btn btn--ghost btn--sm" data-toggle-status' + (isSelf ? " disabled" : "") + '>' + toggleLabel + '</button>' +
            '<button type="button" class="btn btn--ghost btn--sm" data-delete-account' + (isSelf ? " disabled" : "") + '>Delete</button>' +
          '</td>';

        /* role select */
        const roleCell = tr.children[2];
        const select = document.createElement("select");
        select.className = "roleselect";
        select.setAttribute("aria-label", "Role for " + displayName);
        ["student", "faculty", "admin"].forEach((role) => {
          const opt = document.createElement("option");
          opt.value = role;
          opt.textContent = ROLE_LABEL[role];
          if (role === account.role) opt.selected = true;
          select.appendChild(opt);
        });
        if (isSelf) select.disabled = true;

        select.addEventListener("change", async () => {
          const previousRole = account.role;
          const newRole = select.value;
          select.disabled = true;

          const { error } = await db.from("profiles").update({ role: newRole }).eq("id", account.id);

          select.disabled = isSelf;
          if (error) {
            showToast("Couldn't update role: " + error.message);
            select.value = previousRole;
            return;
          }
          account.role = newRole;
          showToast(displayName + " is now " + ROLE_LABEL[newRole].toLowerCase());
        });
        roleCell.appendChild(select);

        /* suspend / reactivate */
        const toggleBtn = tr.querySelector("[data-toggle-status]");
        toggleBtn.addEventListener("click", async () => {
          const newStatus = status === "suspended" ? "active" : "suspended";
          toggleBtn.disabled = true;

          const { error } = await db.from("profiles").update({ status: newStatus }).eq("id", account.id);

          if (error) {
            showToast("Couldn't update status: " + error.message);
            toggleBtn.disabled = false;
            return;
          }
          account.status = newStatus;
          showToast((newStatus === "suspended" ? "Suspended " : "Reactivated ") + displayName);
          renderUsers();
        });

        /* delete account (with inline confirm) */
        const deleteBtn = tr.querySelector("[data-delete-account]");
        const actionsCell = tr.querySelector(".atable__actions");

        deleteBtn.addEventListener("click", () => {
          if (isSelf) return;

          actionsCell.innerHTML =
            '<span class="delete-confirm">Delete this account?</span>' +
            '<button type="button" class="btn btn--ghost btn--sm" data-cancel-delete>Cancel</button>' +
            '<button type="button" class="btn btn--danger btn--sm" data-confirm-delete>Yes, delete</button>';

          actionsCell.querySelector("[data-cancel-delete]").addEventListener("click", () => {
            renderUsers();
          });

          actionsCell.querySelector("[data-confirm-delete]").addEventListener("click", async () => {
            const confirmBtn = actionsCell.querySelector("[data-confirm-delete]");
            const cancelBtn = actionsCell.querySelector("[data-cancel-delete]");
            confirmBtn.disabled = true;
            cancelBtn.disabled = true;
            confirmBtn.textContent = "Deleting…";

            // NOTE: this deletes the profiles row only, not the person's
            // Supabase Auth login (that requires the delete-user Edge
            // Function in supabase/functions/delete-user, not deployed
            // yet). Swap this block for the functions.invoke() version
            // once that's deployed.

            // Unlink (not delete) their uploaded capstones first, so the
            // repository keeps the actual work even after the account
            // that uploaded it is gone.
            const { data: unlinked, error: unlinkError } = await db
              .from("capstones")
              .update({ uploaded_by: null })
              .eq("uploaded_by", account.id)
              .select("id");

            if (unlinkError) {
              showToast("Couldn't delete account: " + unlinkError.message);
              renderUsers();
              return;
            }

            const { error: deleteError } = await db
              .from("profiles")
              .delete()
              .eq("id", account.id);

            if (deleteError) {
              showToast("Couldn't delete account: " + deleteError.message);
              renderUsers();
              return;
            }

            accounts = accounts.filter((a) => a.id !== account.id);
            const n = (unlinked || []).length;
            showToast(
              "Deleted " + displayName +
              (n > 0 ? ". " + n + " capstone" + (n === 1 ? "" : "s") + " kept in the repository, unlinked." : ".")
            );
            renderUsers();
            renderDomainStat();
          });
        });

        tbody.appendChild(tr);
      });
    }

    userSearch.addEventListener("input", renderUsers);
    roleFilter.addEventListener("change", renderUsers);

    /* ---------------- domain stat (real, computed from account emails) ---------------- */

    function renderDomainStat() {
      const valueEl = document.getElementById("domainStatValue");
      const subEl = document.getElementById("domainStatSub");
      const cardEl = document.getElementById("domainCard");

      const domainCounts = {};
      accounts.forEach((a) => {
        const email = a.email || "";
        const at = email.lastIndexOf("@");
        if (at === -1) return;
        const domain = email.slice(at + 1).toLowerCase();
        domainCounts[domain] = (domainCounts[domain] || 0) + 1;
      });

      const domains = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]);

      if (domains.length === 0) {
        valueEl.textContent = "—";
        subEl.textContent = "No accounts registered yet.";
        cardEl.classList.remove("security-card--ok");
        return;
      }

      const [topDomain, topCount] = domains[0];
      valueEl.textContent = topCount + " / " + accounts.length + " on @" + topDomain;

      if (domains.length === 1) {
        subEl.textContent = "Every registered account currently uses this domain.";
        cardEl.classList.add("security-card--ok");
      } else {
        subEl.textContent = "";
        cardEl.classList.remove("security-card--ok");
      }
    }

    await loadAccounts();
    renderUsers();
    renderDomainStat();

    /* ---------------- repository analytics (real capstones data) ---------------- */

    const statCapstones = document.getElementById("statCapstones");
    const statDrafts = document.getElementById("statDrafts");
    const statSecuredDocs = document.getElementById("statSecuredDocs");
    const yearChart = document.getElementById("yearChart");
    const yearChartEmpty = document.getElementById("yearChartEmpty");
    const tagFreqList = document.getElementById("tagFreqList");
    const tagFreqEmpty = document.getElementById("tagFreqEmpty");

    const { data: capstones, error: capstonesError } = await db
      .from("capstones")
      .select("status, year, tags, file_path");

    if (capstonesError) {
      showToast("Couldn't load repository stats: " + capstonesError.message);
    }

    const allCapstones = capstones || [];
    const approved = allCapstones.filter((c) => c.status === "Approved");
    const drafts = allCapstones.filter((c) => c.status === "Draft");
    const withFile = allCapstones.filter((c) => c.file_path);

    statCapstones.textContent = approved.length;
    statDrafts.textContent = drafts.length;
    statSecuredDocs.textContent = allCapstones.length === 0 ? "0 / 0" : (withFile.length + " / " + allCapstones.length);

    /* capstones indexed by year */
    const yearCounts = {};
    approved.forEach((c) => {
      const y = c.year ? String(c.year) : null;
      if (!y) return;
      yearCounts[y] = (yearCounts[y] || 0) + 1;
    });
    const years = Object.keys(yearCounts).sort();

    if (years.length === 0) {
      yearChart.hidden = true;
      yearChartEmpty.hidden = false;
    } else {
      yearChart.hidden = false;
      yearChartEmpty.hidden = true;
      const max = Math.max(...years.map((y) => yearCounts[y]));
      yearChart.innerHTML = years.map((y) => {
        const pct = max > 0 ? Math.max(6, Math.round((yearCounts[y] / max) * 100)) : 6;
        return '<div class="barchart__col"><div class="barchart__bar" style="--h: ' + pct + '%"></div><span>' + escapeHtml(y) + '</span></div>';
      }).join("");
    }

    /* top tags */
    const tagCounts = {};
    approved.forEach((c) => {
      (c.tags || []).filter(Boolean).forEach((t) => {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      });
    });
    const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

    if (topTags.length === 0) {
      tagFreqList.hidden = true;
      tagFreqEmpty.hidden = false;
    } else {
      tagFreqList.hidden = false;
      tagFreqEmpty.hidden = true;
      tagFreqList.innerHTML = topTags.map(([tag, count], i) =>
        '<li><span class="tag ' + TAG_CLASSES[i % TAG_CLASSES.length] + '">' + escapeHtml(tag) + '</span><span class="taglist__count">' + count + '</span></li>'
      ).join("");
    }
  }

  init();
})();