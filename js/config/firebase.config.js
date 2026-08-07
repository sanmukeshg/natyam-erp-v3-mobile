/**
 * Firebase project configuration.
 *
 * These values are meant to be public — Firebase's actual security comes
 * from Firestore Security Rules and Authentication, not from hiding this
 * object, so it is safe to commit as-is once filled in.
 *
 * Replace the placeholders below with the values from:
 * Firebase Console → Project settings (gear icon) → General →
 * Your apps → Web app → SDK setup and configuration → Config.
 */
export const firebaseConfig = {
    apiKey: 'AIzaSyBe9j-coHJiOdUI13vLh7qbhRUVRFtPTx4',
    authDomain: 'natyam-erp.firebaseapp.com',
    projectId: 'natyam-erp',
    storageBucket: 'natyam-erp.firebasestorage.app',
    messagingSenderId: '121454206538',
    appId: '1:121454206538:web:61367aba482a677554d0b3',
    measurementId: 'G-X90ZYBXJSV'
};

/**
 * Web Push certificate public key — UAT5 ENH-510.
 *
 * Generated 2026-08-07: Firebase Console → Project settings → Cloud Messaging
 * → Web Push certificates.
 *
 * Public by design, exactly like everything above it: this is the key a browser
 * presents to prove which application a push subscription belongs to. The
 * PRIVATE half never leaves the Firebase project and this repository never
 * holds it.
 *
 * Empty is still a supported state — pushSupport() reports `configured: false`
 * and the notification settings say push is not set up for this school. Clear
 * this string to turn the feature off everywhere without touching code.
 *
 * ⚠ THE SENDER STILL DOES NOT EXIST. With this key present the app will now
 * register devices and store their tokens, and nothing will ever arrive until
 * a Cloud Function sends something — see docs/push-notifications.md. The
 * settings screen says as much to anyone who enables it.
 */
export const vapidKey = 'BPg3RjeRI1UIg78mahIZpnNBfheyNSpusvM0GXw7ZIfP_xjy_ueCWP0yMLxaimFwVpdPQbhSFwpgNO-pujVwETQ';
