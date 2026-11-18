// Copy the body of this object into config.js when you deploy.

export default {
  // Firebase console > Project settings > Your apps > SDK setup and configuration.
  firebase: {
    apiKey: 'YOUR_WEB_API_KEY',
    authDomain: 'your-project.firebaseapp.com',
    projectId: 'your-project',
    appId: '1:000000000000:web:0000000000000000000000',
  },
  // Firebase AI Logic requires App Check.
  //   'recaptcha-enterprise' or 'recaptcha-v3' with the public site key, for a hosted app;
  //   'debug' for localhost, with the token entered in Settings, never here.
  appCheck: { provider: 'recaptcha-enterprise', siteKey: 'YOUR_RECAPTCHA_SITE_KEY' },
  // Leave empty to use the SDK default cloud model (gemini-3.5-flash-lite in SDK 13.4.0).
  cloudModel: '',
};
