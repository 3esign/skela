// Skela — the real Firebase AI Logic SDK.
// This is the only file that touches Firebase. It is loaded on demand by app.js, so the app
// shell still opens when the SDK cannot be fetched (first visit with no network).
//
// The SDK comes from the Google CDN as ES modules, the documented no-bundler setup. The service
// worker caches these three files after the first load, so later visits work offline.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  ReCaptchaV3Provider,
  CustomProvider,
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app-check.js';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-ai.js';

export const SDK_VERSION = '13.4.0';

/**
 * Initialise Firebase and App Check, and return what hybrid.js needs.
 * Firebase AI Logic requires App Check. Three ways to satisfy it:
 *   recaptcha-enterprise / recaptcha-v3  a public site key, for a hosted app
 *   debug                                a debug token registered in the Firebase console
 */
export function connect(settings) {
  const app = initializeApp(settings.firebase);
  const check = settings.appCheck || {};

  if (check.provider === 'debug') {
    // `true` makes the SDK print a fresh token to the console, to be registered in the Firebase
    // console under App Check > Apps > Manage debug tokens. A string reuses a registered one.
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = check.debugToken || true;
    initializeAppCheck(app, {
      provider: new CustomProvider({ getToken: () => Promise.reject(new Error('Skela runs with an App Check debug token only.')) }),
      isTokenAutoRefreshEnabled: true,
    });
  } else {
    const Provider = check.provider === 'recaptcha-v3' ? ReCaptchaV3Provider : ReCaptchaEnterpriseProvider;
    initializeAppCheck(app, { provider: new Provider(check.siteKey), isTokenAutoRefreshEnabled: true });
  }

  return { app, sdk: { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } };
}
