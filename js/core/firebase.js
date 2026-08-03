/**
 * NATYAM ERP 2.0 — Firebase bootstrap
 *
 * One place that touches the Firebase SDK directly. Everything else imports
 * `auth` and `firestore` from here rather than calling initializeApp itself
 * — the same reason js/core/db.js is the only file that opens IndexedDB.
 *
 * Loaded via the gstatic ESM CDN rather than an npm package: this app has no
 * build step, and the modular v10+ SDK is designed to work exactly this way
 * from a plain `<script type="module">`.
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firebaseConfig } from '../config/firebase.config.js';

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const firestore = getFirestore(app);

/**
 * Subscribes to sign-in/sign-out. A thin wrapper so app.js — the only
 * caller, and not one of this app's three Firebase-facing layers (this
 * file, Authentication Providers, Firestore Repositories) — never imports
 * the Firebase SDK directly either.
 * @param {(user: import('firebase/auth').User | null) => void} callback
 */
export function watchAuthState(callback) {
    return onAuthStateChanged(auth, callback);
}

/**
 * One shared Firebase GoogleAuthProvider instance, configured once. Named
 * `googleAuthProvider` (not `googleProvider`) to leave that name free for
 * the higher-level AuthenticationProvider wrapper in
 * js/services/auth/providers/googleProvider.js, which is what the rest of
 * the app actually imports.
 */
export const googleAuthProvider = new GoogleAuthProvider();
