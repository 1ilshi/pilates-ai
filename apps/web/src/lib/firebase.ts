import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

/**
 * Firebase client for the clinical portal.
 *
 * These values are **public by design** — a Firebase web config is shipped to
 * every browser, and security is enforced by Firestore rules, not by hiding the
 * key. Override them with `VITE_FIREBASE_*` environment variables per
 * environment.
 */
const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "pilates-ai";

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "AIzaSyA_FsX3RBj7bxjO9dMx5QOh2X_JnvBVToo",
  authDomain: `${projectId}.firebaseapp.com`,
  projectId,
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? `${projectId}.firebasestorage.app`,
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
