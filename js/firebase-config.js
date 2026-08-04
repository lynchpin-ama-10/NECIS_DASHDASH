// firebase-config.js
const firebaseConfig = {
  apiKey: "AIzaSyBIUrviEbcR7OVNxjDenqhR528MxkyNruY",
  authDomain: "syringuardiot.firebaseapp.com", //ganti jd necis
  databaseURL: "https://syringuardiot-default-rtdb.asia-southeast1.firebasedatabase.app", //ganti domain jd NECIS
  projectId: "syringuardiot", //ganti jd necis
  storageBucket: "syringuardiot.firebasestorage.app", //ganti
  messagingSenderId: "604061585732",
  appId: "1:604061585732:web:c6276c95dfd84abf3f4711",
  measurementId: "G-FXD87FS7QD"
};

// Inisialisasi Firebase
firebase.initializeApp(firebaseConfig);
const database = firebase.database();
