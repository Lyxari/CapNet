(() => {
  "use strict";

  const overlay = document.getElementById("overlay");
  const modals = {
    signin: document.getElementById("modal-signin"),
    signup: document.getElementById("modal-signup"),
  };

  let activeModal = null;
  let lastFocused = null;

  /* ============================================================
     Real auth via Supabase.
     `window.capnetDB` is the Supabase client set up in
     supabase-config.js (loaded before this file). Signing up
     creates a real auth.users row; a database trigger
     (handle_new_user, set up in the SQL editor) automatically
     mirrors name/email/role into the `profiles` table.

     We still keep a small "capnet_user" object in localStorage —
     not as the source of truth (Supabase's session is), just as
     a quick, synchronous way for dashboard/faculty/admin pages to
     read "who's logged in + what's their role" without an extra
     network round trip on every page load.
     ============================================================ */

  const SESSION_KEY = "capnet_user";
  const db = window.capnetDB;

  function redirectFor(role) {
    if (role === "faculty") return "faculty.html";
    if (role === "admin") return "admin.html";
    return "dashboard.html";
  }

  function saveSession(name, email, role) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ name, email, role }));
    } catch (err) { /* ignore */ }
  }

  /* ---------------- open / close ---------------- */

  function openModal(name) {
    const modal = modals[name];
    if (!modal) return;

    lastFocused = document.activeElement;

    overlay.hidden = false;
    void overlay.offsetWidth;
    overlay.classList.add("is-open");

    Object.values(modals).forEach((m) => {
      m.hidden = m !== modal;
    });

    requestAnimationFrame(() => {
      modal.classList.add("is-visible");
    });

    activeModal = modal;

    const firstField = modal.querySelector("input, select");
    if (firstField) setTimeout(() => firstField.focus(), 320);

    document.addEventListener("keydown", onKeydown);
  }

  function closeModal() {
    if (!activeModal) return;

    activeModal.classList.remove("is-visible");
    overlay.classList.remove("is-open");

    const modalToHide = activeModal;
    setTimeout(() => {
      modalToHide.hidden = true;
      overlay.hidden = true;
      resetForm(modalToHide.querySelector("form"));
    }, 350);

    activeModal = null;
    document.removeEventListener("keydown", onKeydown);

    if (lastFocused) lastFocused.focus();
  }

  function switchModal(name) {
    const current = activeModal;
    const next = modals[name];
    if (!next || current === next) return;

    current.classList.remove("is-visible");

    setTimeout(() => {
      current.hidden = true;
      resetForm(current.querySelector("form"));
      next.hidden = false;
      requestAnimationFrame(() => next.classList.add("is-visible"));
      activeModal = next;

      const firstField = next.querySelector("input, select");
      if (firstField) setTimeout(() => firstField.focus(), 250);
    }, 220);
  }

  function onKeydown(e) {
    if (e.key === "Escape") closeModal();
  }

  /* ---------------- form helpers ---------------- */

  function resetForm(form) {
    if (!form) return;
    form.reset();
    form.removeAttribute("data-success");
    form.removeAttribute("data-loading");
    form.removeAttribute("data-error");
    form.querySelectorAll(".field.is-invalid").forEach((f) => f.classList.remove("is-invalid"));
    const errorEl = form.querySelector(".form__error");
    if (errorEl) errorEl.textContent = "";
  }

  function showError(form, message, invalidFieldNames) {
    form.setAttribute("data-error", "");
    const errorEl = form.querySelector(".form__error");
    if (errorEl) errorEl.textContent = message;

    form.querySelectorAll(".field.is-invalid").forEach((f) => f.classList.remove("is-invalid"));
    (invalidFieldNames || []).forEach((name) => {
      const input = form.elements[name];
      if (input) input.closest(".field").classList.add("is-invalid");
    });
  }

  function showSuccessMessage(form, message) {
    const successEl = form.querySelector(".form__success");
    if (successEl) successEl.textContent = message;
  }

  function clearError(form) {
    form.removeAttribute("data-error");
    form.querySelectorAll(".field.is-invalid").forEach((f) => f.classList.remove("is-invalid"));
  }

  /* ---------------- friendly error messages ---------------- */

  function friendlyAuthError(err) {
    const msg = (err && err.message) || "Something went wrong. Please try again.";
    if (/already registered/i.test(msg)) {
      return "An account with this email already exists. Try signing in instead.";
    }
    if (/invalid login credentials/i.test(msg)) {
      return "Incorrect email or password. Try again.";
    }
    if (/email not confirmed/i.test(msg)) {
      return "Please confirm your email first — check your inbox for a link from Supabase.";
    }
    if (/password/i.test(msg) && /at least/i.test(msg)) {
      return "Password must be at least 6 characters.";
    }
    return msg;
  }

  /* ---------------- submit handling ---------------- */

  async function handleSubmit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    if (form.hasAttribute("data-loading") || form.hasAttribute("data-success")) return;

    clearError(form);

    if (!form.reportValidity()) return;

    const formType = form.getAttribute("data-form");
    const email = form.elements.email.value.trim();
    const password = form.elements.password.value;

    form.setAttribute("data-loading", "");

    if (formType === "signup") {
      const name = form.elements.name.value.trim();
      const role = form.elements.role.value;

      const { data, error } = await db.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: name, role },
        },
      });

      form.removeAttribute("data-loading");

      if (error) {
        showError(form, friendlyAuthError(error), ["email"]);
        return;
      }

      // If the project has "Confirm email" turned OFF, Supabase returns
      // a real session immediately and we can redirect right away.
      // If it's ON (the default), no session comes back yet — the
      // person has to click the confirmation link in their inbox first.
      if (data.session) {
        saveSession(name, email, role);
        form.setAttribute("data-success", "");
        setTimeout(() => {
          window.location.href = redirectFor(role);
        }, 1300);
      } else {
        form.setAttribute("data-success", "");
        showSuccessMessage(form, "Account created — check your email to confirm before signing in.");
      }

      return;
    }

    // Sign in
    const { data, error } = await db.auth.signInWithPassword({ email, password });

    if (error) {
      form.removeAttribute("data-loading");
      showError(form, friendlyAuthError(error), ["email", "password"]);
      return;
    }

    // Pull name + role from the profiles table (filled in automatically
    // at signup by the handle_new_user trigger).
    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("full_name, role, status")
      .eq("id", data.user.id)
      .single();

    form.removeAttribute("data-loading");

    if (profileError || !profile) {
      showError(form, "Signed in, but couldn't load your profile. Contact an admin.", []);
      return;
    }

    if (profile.status === "suspended") {
      await db.auth.signOut();
      showError(form, "This account has been suspended. Contact an administrator.", []);
      return;
    }

    saveSession(profile.full_name, email, profile.role);
    form.setAttribute("data-success", "");

    setTimeout(() => {
      window.location.href = redirectFor(profile.role);
    }, 1300);
  }

  /* ---------------- wiring ---------------- */

  document.querySelectorAll("[data-open-modal]").forEach((btn) => {
    btn.addEventListener("click", () => openModal(btn.getAttribute("data-open-modal")));
  });

  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", closeModal);
  });

  document.querySelectorAll("[data-switch-modal]").forEach((btn) => {
    btn.addEventListener("click", () => switchModal(btn.getAttribute("data-switch-modal")));
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  document.querySelectorAll("[data-form]").forEach((form) => {
    form.addEventListener("submit", handleSubmit);
  });

  /* ---------------- if already signed in, skip the landing pitch ---------------- */
  // (left as opt-in navigation only — we don't auto-redirect away from the
  // marketing page in case a signed-in user wants to see it again.)

  window.addEventListener("load", () => {
    document.body.classList.remove("pre-load");
  });
})();