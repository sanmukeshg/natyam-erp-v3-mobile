/**
 * NATYAM ERP 2.0 — Login screen
 *
 * Not a router `Page`: it renders before the router (and the Shell it
 * depends on) ever mounts. Three sign-in methods, one screen, matching
 * the approved landing/login visual design: a hero ("Get Started") state
 * that reveals a frosted glass sign-in card — Email & Password (primary),
 * Google, and Mobile OTP — desktop and mobile both.
 *
 * Every method funnels into the same outcome handling: a successful
 * `signIn()`/`confirmMobileCode()` call leaves this screen in its loading
 * state and does nothing else — the resulting Firebase auth-state change
 * is handled entirely by app.js's single `onAuthStateChanged` listener,
 * which either mounts the app or re-renders this screen with a rejection
 * message (`initialError`). A thrown error that never reaches that
 * listener at all (a closed Google popup, a wrong password, a bad OTP
 * code, an account not permitted to use this method) is handled directly
 * here.
 *
 * Two different kinds of error reach these catch blocks, and they are not
 * shown the same way. Errors `resolveProvisionedUser()` throws (archived,
 * disabled, method not permitted, not provisioned) are our own `Error`
 * objects with no `.code` — every one of them is written specifically to
 * be safe to show as-is. Anything with a `.code` is a raw Firebase SDK
 * error (`auth/wrong-password`, `auth/invalid-verification-code`, …) —
 * `friendlyAuthError()` below translates the ones this screen can produce
 * into plain, non-technical messages; nothing with a `.code` is ever
 * shown to a person untranslated.
 *
 * The hero↔sign-in reveal and "remember me" are purely presentational —
 * neither touches auth.service.js, Firebase, or session/business logic.
 * "Remember me" only ever persists the identifier field's text to
 * localStorage as a same-device convenience, the same way a browser's own
 * autofill would.
 */

import { html, render, raw, on, formData } from '../../utils/dom.js';
import {
    signIn, sendMobileCode, confirmMobileCode, requestPasswordReset
} from '../../services/auth.service.js';

/** Google's standard multi-colour "G" mark, per their sign-in button branding guidelines. */
const GOOGLE_G_ICON = `
<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
  <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>
  <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
  <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
  <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.581C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>
</svg>`;

/** Must match mobileOtpProvider.js's RECAPTCHA_CONTAINER_ID exactly. */
const RECAPTCHA_CONTAINER_ID = 'mobile-otp-recaptcha';

/** Same-device convenience only — never read by auth.service.js or Firebase. */
const REMEMBER_KEY = 'natyam.rememberedIdentifier';

function errorBanner(message) {
    return html`<div class="alert alert-danger"><p class="alert-body">${message}</p></div>`;
}

function successBanner(message) {
    return html`<div class="alert alert-success"><p class="alert-body">${message}</p></div>`;
}

/**
 * NATYAM's users are all Indian today, and Firebase's `signInWithPhoneNumber`
 * requires full E.164 (a leading `+` and country code) — asking every person
 * to type `+91` themselves on every sign-in is friction with only one
 * possible answer. A number that already has a `+` (someone deliberately
 * entering a different country code) is left exactly as typed; anything
 * else gets `+91` prepended, after stripping spaces/dashes and a leading
 * trunk `0` some people habitually type before a 10-digit mobile number.
 */
function toIndianE164(raw) {
    const digits = String(raw || '').replace(/[^\d+]/g, '');
    if (digits.startsWith('+')) return digits;
    return `+91${digits.replace(/^0+/, '')}`;
}

/**
 * Turns a thrown sign-in error into something safe to show. An error with
 * no `.code` is already one of our own — resolveProvisionedUser()'s
 * rejections are documented as safe to display verbatim. An error *with*
 * a `.code` is a raw Firebase SDK error and is never shown as-is; the
 * known codes this screen can actually produce are translated here, and
 * anything unrecognised falls back to a generic, still non-technical
 * message rather than leaking the code or Firebase's own wording.
 */
function friendlyAuthError(err, fallback) {
    if (!err) return fallback;
    if (!err.code) return err.message || fallback;

    switch (err.code) {
        case 'auth/wrong-password':
        case 'auth/user-not-found':
        case 'auth/invalid-credential':
        case 'auth/invalid-login-credentials':
            return 'Incorrect email or password.';
        case 'auth/invalid-email':
            return 'Enter a valid email address.';
        case 'auth/too-many-requests':
            return 'Too many attempts. Wait a moment and try again.';
        case 'auth/invalid-phone-number':
            return 'Enter a valid mobile number, including the country code.';
        case 'auth/invalid-verification-code':
            return 'That code did not match. Check it and try again.';
        case 'auth/code-expired':
            return 'That code has expired. Request a new one.';
        case 'auth/network-request-failed':
            return 'Network error. Check your connection and try again.';
        case 'auth/operation-not-allowed':
            return 'This sign-in method is not available right now. Try a different method or contact an administrator.';
        default:
            return fallback;
    }
}

/** The one real sign-in card — identical DOM for desktop and mobile, only
 *  repositioned/restyled per breakpoint by auth.css. Rendered exactly once,
 *  never duplicated, so every id below stays unique in the document. */
function signInCardMarkup(initialError) {
    return html`
        <div class="glass-card" tabindex="-1">
            <h1 class="auth-card-title">Sign in to Continue</h1>

            <div data-role="banner" aria-live="polite" aria-atomic="true">${initialError ? errorBanner(initialError) : ''}</div>

            <button class="btn btn-google btn-block" type="button" data-role="google-btn">
                ${raw(GOOGLE_G_ICON)}
                <span>Continue with Google</span>
            </button>

            <!--
              Addressed to parents only, and deliberately silent about staff.
              A parent has no provisioned account, so Google is the only method
              that can create an identity here — email/password and mobile OTP
              both require an account someone already made for you. Staff know
              which method they were given; saying so here would only add a
              line families have to read past to find the one that concerns
              them.
            -->
            <p class="auth-note">
                Parents: please sign in using Continue with Google.
            </p>

            <div class="auth-divider">or sign in with email</div>

            <form data-role="identity-form">
                <div class="field-fl">
                    <input class="auth-input" type="text" id="f-identifier" name="email"
                           placeholder=" " autocomplete="username" required>
                    <label class="field-fl-label" for="f-identifier">Email or Mobile Number</label>
                </div>
                <div class="field-fl" data-role="password-field">
                    <input class="auth-input" type="password" id="f-password" name="password"
                           placeholder=" " autocomplete="current-password" required>
                    <label class="field-fl-label" for="f-password">Password</label>
                </div>
                <div class="auth-row-between">
                    <label class="switch auth-remember">
                        <input type="checkbox" data-role="remember-toggle">
                        <span class="switch-track"></span>
                        Remember me
                    </label>
                    <button class="auth-link-g" type="button" data-role="forgot-btn">Forgot password?</button>
                </div>
                <button class="btn btn-primary btn-block" type="submit" data-role="primary-btn">
                    Login
                </button>
            </form>

            <div data-role="otp-verify" hidden>
                <div class="field-fl">
                    <input class="auth-input" type="text" id="f-otp-code" inputmode="numeric"
                           placeholder=" " autocomplete="one-time-code">
                    <label class="field-fl-label" for="f-otp-code">Enter the code you received</label>
                </div>
                <button class="btn btn-secondary btn-block" type="button" data-role="verify-otp-btn">
                    Verify
                </button>
                <button class="auth-link-g" type="button" data-role="change-number-btn">Use a different number</button>
            </div>

            <div id="${RECAPTCHA_CONTAINER_ID}"></div>
        </div>
    `;
}

/**
 * @param {HTMLElement} container
 * @param {object} [options]
 * @param {string} [options.initialError] A rejection message to show immediately —
 *   set by app.js when it re-renders this screen after a provisioning failure.
 * @param {Function|null} [options.onBack] Supplied only when this screen was
 *   opened from the Public Experience (Stage 1), where the visitor came from
 *   somewhere and needs a way back. Omitted for a rejection or a sign-out,
 *   which reach this screen with nothing behind them — a "back" link there
 *   would lead somewhere the person was never trying to go.
 */
export function renderLogin(container, { initialError = null, onBack = null } = {}) {
    // app.js can call this again on the same #app node without ever
    // unmounting it in between — showLoginScreen() re-invokes renderLogin()
    // after a provisioning rejection. on()'s listeners are scoped to
    // `container` itself, not to the DOM nodes render() is about to
    // replace, so a second call would otherwise stack a second full set of
    // handlers on top of the first and fire every action twice. Tear down
    // whatever a previous call wired up first — the same disposal shape
    // router Page instances use (onDispose()/destroy() in js/core/router.js),
    // just kept locally since this function isn't a Page and has no `this`
    // to hang it from.
    container.__authDisposers?.forEach((dispose) => dispose());
    const disposers = [];
    const onScoped = (...args) => disposers.push(on(...args));
    container.__authDisposers = disposers;

    // Holds the Mobile OTP flow's in-progress confirmation handle between
    // "Send OTP" and "Verify" — this screen has exactly one instance at a
    // time, so a plain closure variable is enough; no component state
    // machine needed for a two-step form.
    let confirmation = null;

    // Which of the two identity-form outcomes the single identifier field
    // currently means — decided live from what's typed (see detectMode()
    // below), not a separate field or a separate form. 'email' is the
    // default: it's the primary method, and it means the Password field
    // doesn't flicker away while someone is still mid-way through typing
    // their email address.
    let mode = 'email';

    // A rejection message must never land behind the still-hidden hero —
    // if there's one, mount straight into the sign-in state so it's seen.
    let showLogin = Boolean(initialError);

    render(container, html`
        <div class="auth-screen" data-state="${showLogin ? 'signin' : 'hero'}">
            <div class="auth-stage">

                <div class="auth-art" aria-hidden="true">
                    <div class="auth-medallion"></div>
                    <p class="auth-tagline">Preserving the Legacy of Kuchipudi</p>
                </div>

                <div class="auth-hero-mobile" data-role="hero-mobile">
                    <div class="auth-hero-mobile-img" role="img" aria-label="Natyam — School of Kuchipudi"></div>
                    <div class="auth-tap-wrap">
                        <div class="auth-tap-shape"></div>
                        <span class="auth-tap-label">Get Started</span>
                        <button class="auth-tap-btn" type="button" data-role="show-login-btn" aria-label="Get Started"></button>
                    </div>
                </div>

                <div class="auth-right">
                    <div class="auth-rightstage">

                        <div class="auth-hero-desktop" data-role="hero-desktop">
                            <div class="auth-brand-block">
                                <div class="auth-wordmark" role="img" aria-label="Natyam — School of Kuchipudi"></div>
                                <p class="auth-unit-tag">— Unit of SSMDA —</p>
                            </div>
                            <button class="auth-cta-btn" type="button" data-role="show-login-btn">Get Started</button>
                        </div>

                        <div class="auth-signin" data-role="signin-panel">
                            <div class="auth-signin-inner">
                                <button class="auth-back-link" type="button" data-role="back-link">← Back</button>
                                ${signInCardMarkup(initialError)}
                                <p class="auth-mobile-tagline" aria-hidden="true">Preserving the Art of Kuchipudi</p>
                            </div>
                        </div>

                    </div>
                </div>

                <div class="auth-foot">
                    ${onBack ? html`
                        <button class="auth-link-g" type="button" data-role="leave-btn">← Back to Natyam</button>
                    ` : ''}
                    <span>© ${new Date().getFullYear()} Natyam School</span>
                </div>
            </div>
        </div>
    `);

    const authScreen = container.querySelector('.auth-screen');
    const heroDesktop = container.querySelector('[data-role="hero-desktop"]');
    const heroMobile = container.querySelector('[data-role="hero-mobile"]');
    const signinPanel = container.querySelector('[data-role="signin-panel"]');
    const banner = container.querySelector('[data-role="banner"]');
    const googleButton = container.querySelector('[data-role="google-btn"]');
    const identityForm = container.querySelector('[data-role="identity-form"]');
    const identifierInput = container.querySelector('#f-identifier');
    const passwordField = container.querySelector('[data-role="password-field"]');
    const passwordInput = container.querySelector('#f-password');
    const primaryButton = container.querySelector('[data-role="primary-btn"]');
    const forgotButton = container.querySelector('[data-role="forgot-btn"]');
    const otpVerify = container.querySelector('[data-role="otp-verify"]');
    const verifyOtpButton = container.querySelector('[data-role="verify-otp-btn"]');
    const rememberToggle = container.querySelector('[data-role="remember-toggle"]');
    const glassCard = container.querySelector('.glass-card');

    /* -------------------------------------------------------- HERO REVEAL */

    /**
     * `inert` (not `hidden`/`display:none`) pulls the inactive side out of
     * the tab order AND the accessibility tree — browsers already treat
     * inert content as hidden from assistive tech, so no separate
     * `aria-hidden` bookkeeping is needed — without touching `display`, so
     * auth.css's opacity/transform cross-fade has something to animate; see
     * the ACCESSIBILITY note at the bottom of auth.css.
     */
    function setInert(el, value) {
        if (!el) return;
        if (value) el.setAttribute('inert', '');
        else el.removeAttribute('inert');
    }

    function applyRevealState() {
        authScreen.dataset.state = showLogin ? 'signin' : 'hero';
        setInert(heroDesktop, showLogin);
        setInert(heroMobile, showLogin);
        setInert(signinPanel, !showLogin);
    }
    applyRevealState();

    onScoped(container, 'click', '[data-role="show-login-btn"]', () => {
        showLogin = true;
        applyRevealState();
        // Focus the revealed card, not the identifier field — same reasoning
        // as the router's own route-change focus move (js/core/router.js):
        // announce the new view to assistive tech without opening a mobile
        // keyboard or nudging the viewport (preventScroll) for a tap that
        // only asked to reveal the sign-in screen, not to start typing yet.
        glassCard.focus({ preventScroll: true });
    });

    // Leaves the login screen entirely and re-enters the Public Experience.
    // Distinct from [data-role="back-link"] below, which only returns the
    // sign-in card to the hero state without leaving this screen at all.
    onScoped(container, 'click', '[data-role="leave-btn"]', () => {
        container.__authDisposers?.forEach((dispose) => dispose());
        container.__authDisposers = null;
        onBack();
    });

    onScoped(container, 'click', '[data-role="back-link"]', () => {
        showLogin = false;
        applyRevealState();
        // Leaving mid-OTP shouldn't strand the screen in the OTP-verify view
        // next time "Get Started" is clicked — same reset as "Use a different number".
        if (!otpVerify.hidden) {
            confirmation = null;
            otpVerify.hidden = true;
            identityForm.hidden = false;
        }
        // Whichever hero variant the current breakpoint actually renders
        // (auth.css decides that, not this code) is the one with a real
        // offsetParent; the other is `display:none`.
        const desktopBtn = heroDesktop.querySelector('[data-role="show-login-btn"]');
        const mobileBtn = heroMobile.querySelector('[data-role="show-login-btn"]');
        const getStartedBtn = desktopBtn?.offsetParent ? desktopBtn : mobileBtn;
        getStartedBtn?.focus({ preventScroll: true });
    });

    /* --------------------------------------------------------- MODE DETECTION */

    /**
     * A phone number never contains "@", so the two are unambiguous once
     * enough is typed. Anything that isn't clearly one or the other yet
     * (empty, or a partial value like "98" or "sanmuk") stays in email
     * mode — the safer default while someone is still typing.
     */
    function detectMode(value) {
        const v = value.trim();
        if (!v || v.includes('@')) return 'email';
        const digits = v.replace(/[\s-]/g, '');
        return /^\+?\d{8,15}$/.test(digits) ? 'mobile' : 'email';
    }

    function applyMode(next) {
        if (next === mode) return;
        mode = next;
        passwordField.hidden = mode === 'mobile';
        passwordInput.required = mode === 'email';
        forgotButton.hidden = mode === 'mobile';
        primaryButton.textContent = mode === 'mobile' ? 'Send OTP' : 'Login';
    }

    onScoped(container, 'input', '#f-identifier', () => applyMode(detectMode(identifierInput.value)));

    /* ------------------------------------------------------------ REMEMBER ME */

    const remembered = localStorage.getItem(REMEMBER_KEY);
    if (remembered) {
        identifierInput.value = remembered;
        rememberToggle.checked = true;
        applyMode(detectMode(remembered));
    }

    onScoped(container, 'change', '[data-role="remember-toggle"]', () => {
        if (!rememberToggle.checked) localStorage.removeItem(REMEMBER_KEY);
    });

    /* ------------------------------------------------------ EMAIL & PASSWORD */

    onScoped(container, 'submit', '[data-role="identity-form"]', async (event) => {
        event.preventDefault();
        render(banner, '');

        if (rememberToggle.checked) localStorage.setItem(REMEMBER_KEY, identifierInput.value.trim());
        else localStorage.removeItem(REMEMBER_KEY);

        primaryButton.setAttribute('data-loading', 'true');
        primaryButton.disabled = true;

        if (mode === 'mobile') {
            try {
                const phoneNumber = toIndianE164(identifierInput.value.trim());
                confirmation = await sendMobileCode(phoneNumber);
                identityForm.hidden = true;
                otpVerify.hidden = false;
                container.querySelector('#f-otp-code').focus();
            } catch (err) {
                console.error('[mobile-otp] sendCode failed', err?.code, err?.message, err);
                render(banner, errorBanner(friendlyAuthError(err, 'Could not send a code. Check the number and try again.')));
            } finally {
                primaryButton.removeAttribute('data-loading');
                primaryButton.disabled = false;
            }
            return;
        }

        try {
            const { email, password } = formData(identityForm);
            await signIn('password', { email, password });
            // Left loading: app.js's onAuthStateChanged listener takes it from here.
        } catch (err) {
            render(banner, errorBanner(friendlyAuthError(err, 'Could not sign in. Check your email and password.')));
            primaryButton.removeAttribute('data-loading');
            primaryButton.disabled = false;
        }
    });

    onScoped(container, 'click', '[data-role="forgot-btn"]', async () => {
        const email = identifierInput.value.trim();
        if (!email) {
            render(banner, errorBanner('Enter your email above first, then click "Forgot password?" again.'));
            return;
        }
        render(banner, '');
        try {
            await requestPasswordReset(email);
            render(banner, successBanner('If that email is registered, a password reset link is on its way.'));
        } catch {
            // Firebase's own error messages for this call can leak whether an
            // email is registered — show the same reassuring message either way.
            render(banner, successBanner('If that email is registered, a password reset link is on its way.'));
        }
    });

    /* -------------------------------------------------------------- GOOGLE */

    onScoped(container, 'click', '[data-role="google-btn"]', async () => {
        render(banner, '');
        googleButton.setAttribute('data-loading', 'true');
        googleButton.disabled = true;

        try {
            await signIn('google');
            // Left loading: the resulting auth-state change is handled by
            // app.js, which either mounts the app or re-renders this screen
            // with a rejection message.
        } catch (err) {
            // The person closed the popup, or the browser blocked it —
            // Firebase's auth state never actually changed, so app.js's
            // listener will not fire for this. Handle it here directly.
            if (err?.code !== 'auth/popup-closed-by-user' && err?.code !== 'auth/cancelled-popup-request') {
                render(banner, errorBanner('Could not open Google sign-in. Check your connection and try again.'));
            }
            googleButton.removeAttribute('data-loading');
            googleButton.disabled = false;
        }
    });

    /* ------------------------------------------------------- MOBILE OTP VERIFY */

    onScoped(container, 'click', '[data-role="verify-otp-btn"]', async () => {
        render(banner, '');
        const code = container.querySelector('#f-otp-code').value.trim();
        verifyOtpButton.setAttribute('data-loading', 'true');
        verifyOtpButton.disabled = true;

        try {
            await confirmMobileCode(confirmation, code);
            // Left loading: same app.js hand-off as every other method.
        } catch (err) {
            console.error('[mobile-otp] confirmCode failed', err?.code, err?.message, err);
            render(banner, errorBanner(friendlyAuthError(err, 'That code did not match. Check it and try again.')));
            verifyOtpButton.removeAttribute('data-loading');
            verifyOtpButton.disabled = false;
        }
    });

    onScoped(container, 'click', '[data-role="change-number-btn"]', () => {
        render(banner, '');
        confirmation = null;
        otpVerify.hidden = true;
        identityForm.hidden = false;
        container.querySelector('#f-otp-code').value = '';
        identifierInput.value = '';
        applyMode('email');
        identifierInput.focus();
    });
}
