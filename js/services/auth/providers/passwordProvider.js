/**
 * NATYAM ERP 2.0 — Email/Password AuthenticationProvider
 *
 * The one file that touches Firebase's Email/Password sign-in mechanics —
 * same role for this provider that googleProvider.js has for Google.
 * Firebase's own servers verify the credential; this app never sees,
 * stores, hashes, or compares a password. This is deliberately not a
 * repeat of ADR-014's removed local-password design (PBKDF2, verified
 * client-side against IndexedDB) — that was "a UI gate, not a real
 * security boundary"; this one has the same server-side trust model
 * Google Sign-In already does.
 */

import { auth } from '../../../core/firebase.js';
import { firebaseConfig } from '../../../config/firebase.config.js';
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
    getAuth, signInWithEmailAndPassword, signOut,
    sendPasswordResetEmail, createUserWithEmailAndPassword,
    EmailAuthProvider, linkWithCredential
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';

export const passwordProvider = {
    id: 'password',

    /**
     * @param {{email: string, password: string}} credentials
     * @returns {Promise<{email: string, name: string, providerUid: string, provider: 'password'}>}
     */
    async signIn({ email, password } = {}) {
        if (!email || !password) throw new Error('Enter your email and password.');
        const { user } = await signInWithEmailAndPassword(auth, email, password);
        return {
            email: user.email,
            name: user.displayName || user.email,
            providerUid: user.uid,
            provider: 'password'
        };
    },

    async signOut() {
        await signOut(auth);
    },

    /** "Forgot password?" — Firebase emails a reset link; the new password is never seen by this app. */
    async sendReset(email) {
        await sendPasswordResetEmail(auth, email);
    },

    /**
     * Administrator-side account creation. createUserWithEmailAndPassword()
     * signs in as the newly created user in whatever Auth instance it's
     * called against — calling it against the app's own shared `auth`
     * would hijack the Administrator's own active session. A second,
     * throwaway Firebase App instance isolates that side effect entirely:
     * it shares the same project/config but has its own independent Auth
     * state, and is discarded the moment this function returns. This is
     * the standard client-SDK-only pattern for "an admin creates another
     * user" without a backend (no Cloud Functions/Admin SDK exist in this
     * project — see ADR-014 §5).
     *
     * Sends a password-reset email immediately after creation so the new
     * person's first real action is choosing their own password, rather
     * than using an administrator-assigned one indefinitely.
     *
     * @param {{email: string, password: string}} account
     */
    async provisionAccount({ email, password }) {
        const provisioningApp = initializeApp(firebaseConfig, `provisioning-${Date.now()}`);
        const provisioningAuth = getAuth(provisioningApp);
        try {
            await createUserWithEmailAndPassword(provisioningAuth, email, password);
            await sendPasswordResetEmail(provisioningAuth, email);
        } finally {
            await deleteApp(provisioningApp);
        }
    },

    /**
     * Self-service only — adds an Email/Password credential to whichever
     * Firebase account is CURRENTLY signed in, via linkWithCredential().
     * This is the only correct way to add a password to an account that
     * already exists under another provider (e.g. Google):
     * createUserWithEmailAndPassword() for an email that already has a
     * Firebase Auth account fails with auth/email-already-in-use, since
     * that function always creates a brand-new, separate identity — it
     * cannot attach a second sign-in method to an existing one. An
     * Administrator cannot do this on someone else's behalf; it can only
     * run while signed in as the account being changed, which is why this
     * takes no email argument — it always targets `auth.currentUser`.
     */
    async linkPassword(password) {
        const current = auth.currentUser;
        if (!current || !current.email) throw new Error('You must be signed in to set a password.');
        const credential = EmailAuthProvider.credential(current.email, password);
        await linkWithCredential(current, credential);
    }
};
