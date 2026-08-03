/**
 * NATYAM ERP 2.0 — Google AuthenticationProvider
 *
 * The one file that touches Google-specific sign-in mechanics. Wraps
 * Firebase's Google popup flow and returns a normalised identity —
 * AuthenticationService (js/services/auth.service.js) never talks to
 * Firebase Auth directly, only to this shape, which is what makes a future
 * provider (Mobile+OTP) a new file rather than a rewrite.
 */

import { auth, googleAuthProvider } from '../../../core/firebase.js';
import { signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';

export const googleProvider = {
    id: 'google',

    /** @returns {Promise<{email: string, name: string, providerUid: string, photoURL: string|null, provider: 'google'}>} */
    async signIn() {
        const { user } = await signInWithPopup(auth, googleAuthProvider);
        return {
            email: user.email,
            name: user.displayName || user.email,
            providerUid: user.uid,
            photoURL: user.photoURL || null,
            provider: 'google'
        };
    },

    async signOut() {
        await signOut(auth);
    }
};
