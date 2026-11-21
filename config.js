// Skela — deployment configuration of the hosted copy (branch gh-pages only; main keeps this empty).
// These are the public web identifiers of the Firebase project. The API is protected by App Check,
// which is enforced on Firebase AI Logic. No debug token is stored here.
export default {
  firebase: {
    apiKey: 'AIzaSyCMExs3vzIsXfSHUSQnQidSpnAvLPm4tHU',
    authDomain: 'aixc-ea17d.firebaseapp.com',
    projectId: 'aixc-ea17d',
    storageBucket: 'aixc-ea17d.firebasestorage.app',
    messagingSenderId: '945072462600',
    appId: '1:945072462600:web:eb75a811a89ffba7862abd',
  },
  appCheck: { provider: 'debug' },
  cloudModel: '',
};
