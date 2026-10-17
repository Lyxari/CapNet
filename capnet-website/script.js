(() => {
  "use strict";

  const overlay = document.getElementById("overlay");
  const modals = {
    signin: document.getElementById("modal-signin"),
    signup: document.getElementById("modal-signup"),
    verify: document.getElementById("modal-verify"),
    forgot: document.getElementById("modal-forgot"),
    reset: document.getElementById("modal-reset"),
  };

  let activeModal = null;
  let lastFocused = null;
  let pendingVerification = null; // { email, name, role, type: 'signup' | 'signin' }
  let pendingResetEmail = null;

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

    if (formType === "signin" || formType === "signup" || formType === "forgot") {
      const email = form.elements.email.value.trim();

      // Restrict authentication strictly to @tip.edu.ph email addresses
      if (!email.toLowerCase().endsWith("@tip.edu.ph")) {
        showError(form, "Please use your valid T.I.P. email address (@tip.edu.ph).", ["email"]);
        return;
      }
    }

    form.setAttribute("data-loading", "");

    if (formType === "signup") {
      const email = form.elements.email.value.trim();
      const password = form.elements.password.value;
      const name = form.elements.name.value.trim();
      let role = form.elements.role.value;
      if (role !== "student" && role !== "faculty") {
        role = "student";
      }

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

      if (data.session) {
        saveSession(name, email, role);
        form.setAttribute("data-success", "");
        setTimeout(() => {
          window.location.href = redirectFor(role);
        }, 1300);
      } else {
        // Transition immediately to the OTP verification modal
        pendingVerification = { email, name, role };
        const verifySub = document.getElementById("verify-sub");
        if (verifySub) {
          verifySub.textContent = `Enter the verification code sent to ${email}`;
        }
        switchModal("verify");
      }

      return;
    }

    if (formType === "verify") {
      const token = form.elements.otp.value.trim();
      const targetEmail = (pendingVerification && pendingVerification.email) || "";
      const verifyType = (pendingVerification && pendingVerification.type) || "signup";

      if (!targetEmail) {
        form.removeAttribute("data-loading");
        showError(form, "Session expired. Please sign up or sign in again.", ["otp"]);
        return;
      }

      if (verifyType === "signin") {
        // Sign-in 2FA: verify OTP with magiclink / email OTP
        const { data, error } = await db.auth.verifyOtp({
          email: targetEmail,
          token: token,
          type: "email",
        });

        if (error) {
          form.removeAttribute("data-loading");
          showError(form, "Invalid or expired 2FA code. Please check your email and try again.", ["otp"]);
          return;
        }

        const fullName = pendingVerification.name || targetEmail.split("@")[0];
        const role = pendingVerification.role || "student";

        saveSession(fullName, targetEmail, role);
        form.setAttribute("data-success", "");
        setTimeout(() => {
          window.location.href = redirectFor(role);
        }, 1200);
        return;
      }

      // Signup verification
      const { data, error } = await db.auth.verifyOtp({
        email: targetEmail,
        token: token,
        type: "signup",
      });

      if (error) {
        form.removeAttribute("data-loading");
        showError(form, "Invalid or expired code. Please check your email and try again.", ["otp"]);
        return;
      }

      // Successfully verified
      const verifiedUser = data.user;
      const meta = (verifiedUser && verifiedUser.user_metadata) || {};
      const fullName = pendingVerification.name || meta.full_name || targetEmail.split("@")[0];
      const role = pendingVerification.role || meta.role || "student";

      // Self-heal / ensure profile row in profiles table
      if (verifiedUser) {
        await db.from("profiles").upsert({
          id: verifiedUser.id,
          email: targetEmail,
          full_name: fullName,
          role: role,
          status: "active",
        });
      }

      saveSession(fullName, targetEmail, role);
      form.setAttribute("data-success", "");
      setTimeout(() => {
        window.location.href = redirectFor(role);
      }, 1200);
      return;
    }

    if (formType === "forgot") {
      const email = form.elements.email.value.trim();

      const { data, error } = await db.auth.resetPasswordForEmail(email);

      form.removeAttribute("data-loading");

      if (error) {
        showError(form, friendlyAuthError(error), ["email"]);
        return;
      }

      pendingResetEmail = email;
      const resetSub = document.getElementById("reset-sub");
      if (resetSub) {
        resetSub.textContent = `Enter the reset code sent to ${email} and your new password.`;
      }
      form.setAttribute("data-success", "");
      setTimeout(() => {
        switchModal("reset");
      }, 1200);
      return;
    }

    if (formType === "reset") {
      const token = form.elements.otp.value.trim();
      const newPassword = form.elements.newPassword.value;
      const targetEmail = pendingResetEmail || "";

      if (!targetEmail) {
        form.removeAttribute("data-loading");
        showError(form, "Session expired. Please request a new reset code.", ["otp"]);
        return;
      }

      // Verify recovery code
      const { data, error } = await db.auth.verifyOtp({
        email: targetEmail,
        token: token,
        type: "recovery",
      });

      if (error) {
        form.removeAttribute("data-loading");
        showError(form, "Invalid or expired reset code. Please try again.", ["otp"]);
        return;
      }

      // Update password
      const { error: updateError } = await db.auth.updateUser({
        password: newPassword,
      });

      form.removeAttribute("data-loading");

      if (updateError) {
        showError(form, friendlyAuthError(updateError), ["newPassword"]);
        return;
      }

      form.setAttribute("data-success", "");
      setTimeout(() => {
        switchModal("signin");
      }, 1600);
      return;
    }

    // Sign in
    const email = form.elements.email.value.trim();
    const password = form.elements.password.value;
    const { data, error } = await db.auth.signInWithPassword({ email, password });

    if (error) {
      form.removeAttribute("data-loading");
      showError(form, friendlyAuthError(error), ["email", "password"]);
      return;
    }

    // Pull name + role from the profiles table.
    let { data: profile, error: profileError } = await db
      .from("profiles")
      .select("full_name, role, status")
      .eq("id", data.user.id)
      .maybeSingle();

    // If profile row doesn't exist yet, initialize it
    if (!profile) {
      const meta = data.user.user_metadata || {};
      const fallbackName = meta.full_name || email.split("@")[0];
      const fallbackRole = meta.role || "student";

      const { data: newProfile, error: insertError } = await db
        .from("profiles")
        .upsert({
          id: data.user.id,
          email: email,
          full_name: fallbackName,
          role: fallbackRole,
          status: "active",
        })
        .select()
        .single();

      if (!insertError && newProfile) {
        profile = newProfile;
      } else {
        profile = {
          full_name: fallbackName,
          role: fallbackRole,
          status: "active",
        };
      }
    }

    if (profile.status === "suspended") {
      form.removeAttribute("data-loading");
      await db.auth.signOut();
      showError(form, "This account has been suspended. Contact an administrator.", []);
      return;
    }

    // 2FA Security Step on Sign In:
    // User password was verified. Now send 2FA OTP code to their email.
    // Temporarily sign out the session until 2FA code is entered.
    await db.auth.signOut();

    // Send 2FA code via OTP
    const { error: otpError } = await db.auth.signInWithOtp({
      email: email,
      options: { shouldCreateUser: false },
    });

    form.removeAttribute("data-loading");

    if (otpError) {
      // If OTP email fails to send, display the error
      showError(form, "Password verified, but couldn't send 2FA code: " + otpError.message, ["email"]);
      return;
    }

    // Direct user to verify 2FA code
    pendingVerification = {
      email: email,
      name: profile.full_name,
      role: profile.role,
      type: "signin",
    };

    const verifyTitle = document.getElementById("verify-title");
    const verifySub = document.getElementById("verify-sub");
    if (verifyTitle) verifyTitle.textContent = "2FA Login Verification";
    if (verifySub) verifySub.textContent = `Password verified! Enter the 2FA login code sent to ${email}`;

    switchModal("verify");
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

  const resendBtn = document.getElementById("btn-resend-otp");
  if (resendBtn) {
    resendBtn.addEventListener("click", async () => {
      if (!pendingVerification || !pendingVerification.email) return;
      resendBtn.disabled = true;
      const originalText = resendBtn.textContent;
      let error;
      if (pendingVerification.type === "signin") {
        const res = await db.auth.signInWithOtp({
          email: pendingVerification.email,
          options: { shouldCreateUser: false },
        });
        error = res.error;
      } else {
        const res = await db.auth.resend({
          type: "signup",
          email: pendingVerification.email,
        });
        error = res.error;
      }
      if (!error) {
        resendBtn.textContent = "Code resent!";
        setTimeout(() => {
          resendBtn.textContent = originalText;
          resendBtn.disabled = false;
        }, 5000);
      } else {
        resendBtn.textContent = "Failed to resend";
        setTimeout(() => {
          resendBtn.textContent = originalText;
          resendBtn.disabled = false;
        }, 3000);
      }
    });
  }

  /* ---------------- if already signed in, skip the landing pitch ---------------- */
  // (left as opt-in navigation only — we don't auto-redirect away from the
  // marketing page in case a signed-in user wants to see it again.)

  window.addEventListener("load", () => {
    document.body.classList.remove("pre-load");
  });
})();