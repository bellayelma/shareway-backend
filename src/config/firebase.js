const admin = require('firebase-admin');
const path = require('path');

let db, adminInstance;

const initializeFirebase = () => {
  try {
    if (!process.env.FIREBASE_KEY) {
      throw new Error('FIREBASE_KEY environment variable is not set');
    }

    const firebaseConfig = JSON.parse(process.env.FIREBASE_KEY);
    
    if (firebaseConfig.private_key && typeof firebaseConfig.private_key === 'string') {
      firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, '\n');
    }

    adminInstance = admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });

    db = adminInstance.firestore();
    db.settings({ ignoreUndefinedProperties: true });
    
    console.log('✅ Firebase Admin initialized');
    
    return { db, admin: adminInstance };
    
  } catch (error) {
    console.error('❌ Firebase Admin initialization failed:', error.message);
    process.exit(1);
  }
};

// Initialize immediately
const { db: firestoreDb, admin: firebaseAdmin } = initializeFirebase();

module.exports = {
  db: firestoreDb,
  admin: firebaseAdmin
};
